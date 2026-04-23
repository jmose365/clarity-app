module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const PO_TOKEN = process.env.PUSHOVER_TOKEN;
  const JAY_KEY  = process.env.PUSHOVER_JAY;
  const CHARI_KEY= process.env.PUSHOVER_CHARI;

  if (!SUPA_URL || !SUPA_KEY || !PO_TOKEN || !JAY_KEY) {
    return res.status(500).json({ error: 'Missing env vars', SUPA_URL:!!SUPA_URL, SUPA_KEY:!!SUPA_KEY, PO_TOKEN:!!PO_TOKEN, JAY_KEY:!!JAY_KEY });
  }

  async function db(table, filters, selectCols) {
    const url = new URL(`${SUPA_URL}/rest/v1/${table}`);
    url.searchParams.set('select', selectCols || '*');
    Object.entries(filters || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url.toString(), {
      headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Accept': 'application/json' }
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch(e) { return { _error: text }; }
  }

  async function push(key, title, msg, priority, sound) {
    if (!key) return;
    return fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: PO_TOKEN, user: key, title, message: msg, priority: priority ?? 0, sound: sound || 'pushover' })
    });
  }

  async function pushBoth(title, msg, priority, sound) {
    await Promise.all([
      push(JAY_KEY, title, msg, priority, sound),
      CHARI_KEY ? push(CHARI_KEY, title, msg, priority, sound) : null
    ].filter(Boolean));
  }

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const todayDOM = now.getDate();
  const todayDay = now.getDay(); // 0=Sun,1=Mon,...,6=Sat
  function addDays(n) { const d = new Date(now); d.setDate(d.getDate() + n); return d.getDate(); }
  function money(n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); }

  const results = [];

  try {
    const households = await db('households', {}, 'id');
    if (!Array.isArray(households)) return res.status(500).json({ error: 'No households', raw: households });

    for (const hh of households) {
      const hid = hh.id;

      const [expenses, profiles, lastActArr, lastCheckinArr] = await Promise.all([
        db('expenses', { 'household_id': `eq.${hid}`, 'is_recurring': 'eq.true' }),
        db('user_profiles', { 'household_id': `eq.${hid}`, 'limit': 1 }),
        db('activity_log', { 'household_id': `eq.${hid}`, 'order': 'created_at.desc', 'limit': 1 }),
        db('checkins', { 'household_id': `eq.${hid}`, 'order': 'created_at.desc', 'limit': 1 })
      ]);

      const EX = Array.isArray(expenses) ? expenses : [];
      const profile = Array.isArray(profiles) ? profiles[0] : null;
      const lastAct = Array.isArray(lastActArr) ? lastActArr[0] : null;
      const lastCheckin = Array.isArray(lastCheckinArr) ? lastCheckinArr[0] : null;

      const paycheck = profile?.paycheck_amount || 0;
      const payDates = Array.isArray(profile?.pay_dates) ? profile.pay_dates : [];
      const pastDue = EX.filter(e => e.is_past_due);

      // ── CHECK-IN REMINDERS ─────────────────────────────────────────
      // Wednesday (3), Friday (5), Sunday (0)
      const isCheckinDay = [0, 3, 5].includes(todayDay);
      if (isCheckinDay) {
        const checkinType = todayDay === 0 ? 'sunday' : todayDay === 3 ? 'wednesday' : 'friday';
        // Check if already completed today
        const alreadyDone = lastCheckin?.checkin_date === todayStr && lastCheckin?.checkin_type === checkinType;

        if (!alreadyDone) {
          let title, msg;
          if (checkinType === 'wednesday') {
            title = '📋 Wednesday Check-In';
            msg = `Mid-week sync time. Update your balance, confirm any paychecks, and acknowledge what's due. Takes 2 minutes.`;
          } else if (checkinType === 'friday') {
            title = '📋 Friday Check-In';
            const upcomingWeekend = EX.filter(e => !e.is_past_due && (e.due_day === addDays(1) || e.due_day === addDays(2)));
            const pdCount = pastDue.length;
            msg = `Weekend prep time. You have ${pdCount > 0 ? pdCount + ' past due bill' + (pdCount > 1 ? 's' : '') + ' and ' : ''}${upcomingWeekend.length} bill${upcomingWeekend.length !== 1 ? 's' : ''} due this weekend. Set your budget before Saturday hits.`;
          } else {
            title = '📋 Sunday Check-In';
            const upcomingWeek = EX.filter(e => !e.is_past_due && e.due_day >= todayDOM && e.due_day <= todayDOM + 7);
            msg = `Week reset time. ${pastDue.length > 0 ? pastDue.length + ' bill' + (pastDue.length > 1 ? 's' : '') + ' still past due. ' : 'No past due bills. '}${upcomingWeek.length} bill${upcomingWeek.length !== 1 ? 's' : ''} coming this week. Open ¢larity.`;
          }
          await pushBoth(title, msg, 0, 'pushover');
          results.push(`checkin_${checkinType}`);
        } else {
          results.push(`checkin_${checkinType}_already_done`);
        }
      }

      // ── PAYCHECK DAY ────────────────────────────────────────────────
      if (payDates.includes(todayStr)) {
        await pushBoth('💰 Paycheck Day', `Your ${money(paycheck)} should arrive today. Open ¢larity and log it during your check-in.`, 1, 'cashregister');
        results.push('paycheck_day');
      }

      // ── DUE TOMORROW ───────────────────────────────────────────────
      const dom1 = addDays(1);
      const dueTomorrow = EX.filter(e => !e.is_past_due && (e.due_day === dom1 || e.due_day_2 === dom1));
      for (const bill of dueTomorrow) {
        // Don't double-notify on check-in days — the check-in covers this
        if (!isCheckinDay) {
          await pushBoth(`🚨 ${bill.name} Due Tomorrow`, `${money(bill.amount)} is due tomorrow. Open ¢larity to earmark or pay.`, 1, 'siren');
        }
      }
      if (dueTomorrow.length) results.push(`due_tomorrow:${dueTomorrow.length}`);

      // ── DUE IN 3 DAYS ──────────────────────────────────────────────
      const dom3 = addDays(3);
      const due3 = EX.filter(e => !e.is_past_due && (e.due_day === dom3 || e.due_day_2 === dom3));
      for (const bill of due3) {
        if (!isCheckinDay) {
          await pushBoth(`⏰ ${bill.name} in 3 Days`, `${money(bill.amount)} is due in 3 days. Earmark it now in ¢larity.`, 0, 'pushover');
        }
      }
      if (due3.length) results.push(`due_3days:${due3.length}`);

      // ── UPCOMING WEEK SUMMARY (non-check-in days only) ─────────────
      if (!isCheckinDay && !dueTomorrow.length && !due3.length) {
        const seen = new Set();
        const upcomingWeek = [];
        for (let d = 0; d <= 7; d++) {
          const dom = addDays(d);
          EX.forEach(e => {
            if (!e.is_past_due && (e.due_day === dom || e.due_day_2 === dom) && !seen.has(e.id)) {
              seen.add(e.id); upcomingWeek.push(e);
            }
          });
        }
        if (upcomingWeek.length > 0) {
          const total = upcomingWeek.reduce((s, e) => s + (e.amount || 0), 0);
          const names = [...new Set(upcomingWeek.map(e => e.name))].slice(0, 3).join(', ');
          await pushBoth('📅 Bills This Week', `${upcomingWeek.length} bill${upcomingWeek.length > 1 ? 's' : ''} due — ${money(total)} total. ${names}${upcomingWeek.length > 3 ? ' + more' : ''}. Open ¢larity.`, -1, 'none');
          results.push(`week_summary:${upcomingWeek.length}`);
        }
      }

      // ── PAST DUE — DAILY ───────────────────────────────────────────
      // Skip on check-in days — the check-in notification covers this
      if (!isCheckinDay) {
        for (const bill of pastDue.slice(0, 3)) {
          const total = (bill.past_due_amount || bill.amount || 0) + (bill.late_charge || 0);
          await pushBoth(`🔴 ${bill.name} Still Past Due`, `${money(total)} total due${bill.late_charge ? ` (incl. ${money(bill.late_charge)} late fee)` : ''}. Open ¢larity.`, 1, 'siren');
        }
        if (pastDue.length) results.push(`past_due:${pastDue.length}`);
      }

      // ── INACTIVITY NUDGE (non-check-in days, 3+ days silent) ───────
      if (!isCheckinDay && lastAct?.created_at) {
        const daysSince = Math.floor((now - new Date(lastAct.created_at)) / 86400000);
        if (daysSince >= 3) {
          await pushBoth('👋 ¢larity Misses You', `No activity in ${daysSince} days. Bills keep moving — your plan should too. Open ¢larity.`, -1, 'none');
          results.push(`inactivity:${daysSince}days`);
        }
      }

      // ── WEEKLY RECAP — Sundays only ────────────────────────────────
      if (todayDay === 0) {
        const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = weekAgo.toISOString().split('T')[0];
        const [paidRes, txRes] = await Promise.all([
          db('expense_payments', { 'household_id': `eq.${hid}`, 'paid_date': `gte.${weekAgoStr}` }, 'id'),
          db('transactions', { 'household_id': `eq.${hid}`, 'transaction_date': `gte.${weekAgoStr}` }, 'id')
        ]);
        const paidCount = Array.isArray(paidRes) ? paidRes.length : 0;
        const txCount = Array.isArray(txRes) ? txRes.length : 0;
        const position = pastDue.length > 0 ? 'Behind' : 'Current';
        // Append recap to the check-in notification (don't send separately)
        results.push(`weekly_recap:paid=${paidCount},tx=${txCount},pos=${position}`);
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }

  return res.status(200).json({ ok: true, ran: results, date: todayStr });
};

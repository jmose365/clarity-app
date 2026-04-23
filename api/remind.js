// ¢larity Daily Reminders — CommonJS, no dependencies
// Requires Node 18+ for native fetch (set in vercel.json)

module.exports = async function handler(req, res) {

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const PO_TOKEN = process.env.PUSHOVER_TOKEN;
  const JAY_KEY  = process.env.PUSHOVER_JAY;
  const CHARI_KEY= process.env.PUSHOVER_CHARI;

  // Env check
  if (!SUPA_URL || !SUPA_KEY || !PO_TOKEN || !JAY_KEY) {
    return res.status(500).json({
      error: 'Missing env vars',
      SUPA_URL: !!SUPA_URL,
      SUPA_KEY: !!SUPA_KEY,
      PO_TOKEN: !!PO_TOKEN,
      JAY_KEY:  !!JAY_KEY
    });
  }

  // Supabase REST — returns parsed JSON or throws
  async function db(table, filters) {
    const url = new URL(`${SUPA_URL}/rest/v1/${table}`);
    url.searchParams.set('select', '*');
    Object.entries(filters || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url.toString(), {
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Accept': 'application/json',
        'Prefer': 'return=representation'
      }
    });
    const text = await r.text();
    try { return JSON.parse(text); }
    catch(e) { return { _error: text }; }
  }

  // Pushover
  async function push(key, title, msg, priority, sound) {
    if (!key) return;
    return fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: PO_TOKEN, user: key, title, message: msg,
        priority: priority ?? 0, sound: sound || 'pushover'
      })
    });
  }

  async function pushBoth(title, msg, priority, sound) {
    await Promise.all([
      push(JAY_KEY, title, msg, priority, sound),
      CHARI_KEY ? push(CHARI_KEY, title, msg, priority, sound) : null
    ].filter(Boolean));
  }

  const now      = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const todayDOM = now.getDate();
  const todayDay = now.getDay(); // 0=Sun

  function domIn(days) {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d.getDate();
  }

  function money(n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); }

  const results = [];
  const errors  = [];

  try {
    // Load all households
    const households = await db('households', {});
    if (!Array.isArray(households)) {
      return res.status(500).json({ error: 'Could not load households', raw: households });
    }

    for (const hh of households) {
      const hid = hh.id;

      // Load expenses, profiles, last activity in parallel
      const [expenses, profiles, lastActArr] = await Promise.all([
        db('expenses', {
          'household_id': `eq.${hid}`,
          'is_recurring':  'eq.true'
        }),
        db('user_profiles', {
          'household_id': `eq.${hid}`,
          'limit': 1
        }),
        db('activity_log', {
          'household_id': `eq.${hid}`,
          'order':        'created_at.desc',
          'limit':        1
        })
      ]);

      const EX      = Array.isArray(expenses)    ? expenses    : [];
      const profile = Array.isArray(profiles)    ? profiles[0] : null;
      const lastAct = Array.isArray(lastActArr)  ? lastActArr[0]: null;

      const paycheck  = profile?.paycheck_amount || 0;
      const payDates  = Array.isArray(profile?.pay_dates) ? profile.pay_dates : [];

      // ── 1. PAYCHECK DAY ────────────────────────────────────────────
      if (payDates.includes(todayStr)) {
        await pushBoth(
          '💰 Paycheck Day',
          `Your ${money(paycheck)} should arrive today. Open ¢larity, log it, and earmark your bills before it disappears.`,
          1, 'cashregister'
        );
        results.push('paycheck_day');
      }

      // ── 2. DUE TOMORROW ───────────────────────────────────────────
      const dom1 = domIn(1);
      const dueTomorrow = EX.filter(e =>
        !e.is_past_due && (e.due_day === dom1 || e.due_day_2 === dom1)
      );
      for (const bill of dueTomorrow) {
        await pushBoth(
          `🚨 ${bill.name} Due Tomorrow`,
          `${money(bill.amount)} is due tomorrow. Open ¢larity to earmark or pay.`,
          1, 'siren'
        );
      }
      if (dueTomorrow.length) results.push(`due_tomorrow:${dueTomorrow.length}`);

      // ── 3. DUE IN 3 DAYS ──────────────────────────────────────────
      const dom3 = domIn(3);
      const due3 = EX.filter(e =>
        !e.is_past_due && (e.due_day === dom3 || e.due_day_2 === dom3)
      );
      for (const bill of due3) {
        await pushBoth(
          `⏰ ${bill.name} in 3 Days`,
          `${money(bill.amount)} is due in 3 days. Earmark it now in ¢larity.`,
          0, 'pushover'
        );
      }
      if (due3.length) results.push(`due_3days:${due3.length}`);

      // ── 4. UPCOMING WEEK SUMMARY ───────────────────────────────────
      if (!dueTomorrow.length && !due3.length) {
        const seen = new Set();
        const upcomingWeek = [];
        for (let d = 0; d <= 7; d++) {
          const dom = domIn(d);
          EX.forEach(e => {
            if (!e.is_past_due && (e.due_day === dom || e.due_day_2 === dom) && !seen.has(e.id)) {
              seen.add(e.id);
              upcomingWeek.push(e);
            }
          });
        }
        if (upcomingWeek.length > 0) {
          const total = upcomingWeek.reduce((s, e) => s + (e.amount || 0), 0);
          const names = [...new Set(upcomingWeek.map(e => e.name))].slice(0, 3).join(', ');
          await pushBoth(
            '📅 Bills This Week',
            `${upcomingWeek.length} bill${upcomingWeek.length > 1 ? 's' : ''} due — ${money(total)} total. ${names}${upcomingWeek.length > 3 ? ' + more' : ''}. Open ¢larity.`,
            -1, 'none'
          );
          results.push(`week_summary:${upcomingWeek.length}`);
        }
      }

      // ── 5. PAST DUE — DAILY ────────────────────────────────────────
      const pastDue = EX.filter(e => e.is_past_due);
      for (const bill of pastDue.slice(0, 3)) {
        const total = (bill.past_due_amount || bill.amount || 0) + (bill.late_charge || 0);
        await pushBoth(
          `🔴 ${bill.name} Still Past Due`,
          `${money(total)} total due${bill.late_charge ? ` (incl. ${money(bill.late_charge)} late fee)` : ''}. Open ¢larity.`,
          1, 'siren'
        );
      }
      if (pastDue.length) results.push(`past_due:${pastDue.length}`);

      // ── 6. INACTIVITY NUDGE ────────────────────────────────────────
      if (lastAct?.created_at) {
        const daysSince = Math.floor((now - new Date(lastAct.created_at)) / 86400000);
        if (daysSince >= 3) {
          await pushBoth(
            `👋 ¢larity Misses You`,
            `No activity in ${daysSince} days. Bills keep moving — your plan should too. Open ¢larity.`,
            -1, 'none'
          );
          results.push(`inactivity:${daysSince}days`);
        }
      }

      // ── 7. WEEKLY RECAP — Sundays only ────────────────────────────
      if (todayDay === 0) {
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = weekAgo.toISOString().split('T')[0];

        const [paidRes, txRes] = await Promise.all([
          db('expense_payments', { 'household_id': `eq.${hid}`, 'paid_date': `gte.${weekAgoStr}`, 'select': 'id' }),
          db('transactions',     { 'household_id': `eq.${hid}`, 'transaction_date': `gte.${weekAgoStr}`, 'select': 'id' })
        ]);

        const paidCount = Array.isArray(paidRes) ? paidRes.length : 0;
        const txCount   = Array.isArray(txRes)   ? txRes.length   : 0;
        const position  = pastDue.length > 0 ? 'Behind' : 'Current';

        await pushBoth(
          '📊 Weekly ¢larity Recap',
          `This week: ${paidCount} bill${paidCount !== 1 ? 's' : ''} paid, ${txCount} transaction${txCount !== 1 ? 's' : ''} logged. Position: ${position}. Keep going.`,
          -1, 'none'
        );
        results.push('weekly_recap');
      }
    }

  } catch (err) {
    errors.push(err.message || String(err));
    return res.status(500).json({ error: err.message, stack: err.stack });
  }

  return res.status(200).json({ ok: true, ran: results, errors, date: todayStr });
};

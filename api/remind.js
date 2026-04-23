import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Allow manual trigger via GET for testing, cron via GET as well
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const pushoverToken = process.env.PUSHOVER_TOKEN;
  const jayKey = process.env.PUSHOVER_JAY;
  const chariKey = process.env.PUSHOVER_CHARI;

  if (!pushoverToken || !jayKey) {
    return res.status(500).json({ error: 'Pushover not configured' });
  }

  const results = [];

  // Helper: send Pushover to one or both users
  async function push(userKey, title, message, priority = 0, sound = 'pushover') {
    if (!userKey) return;
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pushoverToken, user: userKey, title, message, priority, sound })
    });
  }

  async function pushBoth(title, message, priority = 0, sound = 'pushover') {
    await Promise.all([
      push(jayKey, title, message, priority, sound),
      chariKey ? push(chariKey, title, message, priority, sound) : Promise.resolve()
    ]);
  }

  // Get today's date info
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const todayDOM = now.getDate();
  const todayDay = now.getDay(); // 0=Sun, 6=Sat

  // Load all households
  const { data: households } = await supabase.from('households').select('*');
  if (!households) return res.status(500).json({ error: 'No households found' });

  for (const household of households) {
    const hid = household.id;

    // Load data for this household
    const [expRes, settingsRes, actRes, profilesRes] = await Promise.all([
      supabase.from('expenses').select('*').eq('household_id', hid).eq('is_recurring', true),
      supabase.from('household_settings').select('*').eq('household_id', hid).single(),
      supabase.from('activity_log').select('created_at').eq('household_id', hid).order('created_at', { ascending: false }).limit(1),
      supabase.from('user_profiles').select('*').eq('household_id', hid)
    ]);

    const expenses = expRes.data || [];
    const settings = settingsRes.data || {};
    const lastActivity = actRes.data?.[0];
    const profiles = profilesRes.data || [];

    const paycheck = profiles[0]?.paycheck_amount || 0;
    const payDates = profiles[0]?.pay_dates || [];

    // ── 1. PAYCHECK DAY ──────────────────────────────────────────────
    if (payDates.includes(todayStr)) {
      await pushBoth(
        '💰 Paycheck Day',
        `Your $${paycheck.toLocaleString()} should arrive today. Open ¢larity, log it, and earmark your bills before it disappears.`,
        1, // high priority
        'cashregister'
      );
      results.push('paycheck_day');
    }

    // ── 2. BILL DUE TOMORROW (1 day) ─────────────────────────────────
    const tomorrowDOM = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getDate();
    const dueTomorrow = expenses.filter(e =>
      !e.is_past_due && (e.due_day === tomorrowDOM || e.due_day_2 === tomorrowDOM)
    );
    for (const bill of dueTomorrow) {
      await pushBoth(
        `🚨 ${bill.name} Due Tomorrow`,
        `$${bill.amount.toLocaleString()} is due tomorrow. Open ¢larity to earmark or pay.`,
        1, 'siren'
      );
    }
    if (dueTomorrow.length > 0) results.push(`due_tomorrow:${dueTomorrow.length}`);

    // ── 3. BILLS DUE IN 3 DAYS ───────────────────────────────────────
    const in3DOM = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).getDate();
    const due3 = expenses.filter(e =>
      !e.is_past_due && (e.due_day === in3DOM || e.due_day_2 === in3DOM)
    );
    for (const bill of due3) {
      await pushBoth(
        `⏰ ${bill.name} in 3 Days`,
        `$${bill.amount.toLocaleString()} is due in 3 days. Earmark it now in ¢larity.`,
        0, 'pushover'
      );
    }
    if (due3.length > 0) results.push(`due_3days:${due3.length}`);

    // ── 4. DAILY UPCOMING SUMMARY (8am only) ─────────────────────────
    const upcomingWeek = [];
    for (let d = 0; d <= 7; d++) {
      const checkDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const dom = checkDate.getDate();
      expenses.forEach(e => {
        if (!e.is_past_due && (e.due_day === dom || e.due_day_2 === dom)) {
          upcomingWeek.push(e);
        }
      });
    }

    if (upcomingWeek.length > 0 && dueTomorrow.length === 0 && due3.length === 0) {
      // Only send summary if no specific bill alerts already sent
      const total = upcomingWeek.reduce((s, e) => s + e.amount, 0);
      const names = [...new Set(upcomingWeek.map(e => e.name))].slice(0, 3).join(', ');
      await pushBoth(
        '📅 Bills Due This Week',
        `You have ${upcomingWeek.length} bill${upcomingWeek.length > 1 ? 's' : ''} due — $${total.toLocaleString()} total. ${names}${upcomingWeek.length > 3 ? ' + more' : ''}. Open ¢larity.`,
        -1, 'none'
      );
      results.push(`weekly_summary:${upcomingWeek.length}`);
    }

    // ── 5. PAST DUE — DAILY UNTIL CLEARED ───────────────────────────
    const pastDue = expenses.filter(e => e.is_past_due);
    for (const bill of pastDue.slice(0, 3)) {
      const total = (bill.past_due_amount || bill.amount) + (bill.late_charge || 0);
      await pushBoth(
        `🔴 ${bill.name} Still Past Due`,
        `$${total.toLocaleString()} total due${bill.late_charge ? ` (includes $${bill.late_charge} late fee)` : ''}. Open ¢larity to make a plan.`,
        1, 'siren'
      );
    }
    if (pastDue.length > 0) results.push(`past_due:${pastDue.length}`);

    // ── 6. INACTIVITY NUDGE (no activity in 3+ days) ────────────────
    if (lastActivity) {
      const lastDate = new Date(lastActivity.created_at);
      const daysSince = Math.floor((now - lastDate) / 86400000);
      if (daysSince >= 3) {
        await pushBoth(
          `👋 ¢larity Misses You`,
          `No activity in ${daysSince} days. Bills keep moving — your plan shouldn't stand still. Open ¢larity.`,
          -1, 'none'
        );
        results.push(`inactivity:${daysSince}days`);
      }
    }

    // ── 7. WEEKLY RECAP (Sundays only) ──────────────────────────────
    if (todayDay === 0) {
      const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString();
      const [paidRes, txRes] = await Promise.all([
        supabase.from('expense_payments').select('*').eq('household_id', hid).gte('paid_date', weekAgo),
        supabase.from('transactions').select('*').eq('household_id', hid).gte('created_at', weekAgo)
      ]);
      const paidCount = paidRes.data?.length || 0;
      const txCount = txRes.data?.length || 0;
      const pdCount = pastDue.length;
      const position = pdCount > 0 ? 'Behind' : 'Current';

      await pushBoth(
        '📊 Weekly ¢larity Recap',
        `This week: ${paidCount} bill${paidCount !== 1 ? 's' : ''} paid, ${txCount} transaction${txCount !== 1 ? 's' : ''} logged. Position: ${position}. Keep going.`,
        -1, 'none'
      );
      results.push('weekly_recap');
    }
  }

  return res.status(200).json({ ok: true, ran: results, date: todayStr });
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.PUSHOVER_TOKEN;
  const jayKey = process.env.PUSHOVER_JAY;
  const chariKey = process.env.PUSHOVER_CHARI; // may be empty until Chari joins

  if (!token || !jayKey) {
    return res.status(500).json({ error: 'Pushover not fully configured' });
  }

  const { event_type, actor_id, actor_name, jay_id, description, amount } = req.body;

  // Notification messages
  const messages = {
    paycheck_logged:      { title: 'Paycheck Logged 💰',    msg: `${actor_name} logged a paycheck${amount ? ' — $' + Number(amount).toLocaleString() : ''}` },
    expense_paid:         { title: 'Bill Paid ✅',           msg: `${actor_name} paid ${description}` },
    expense_paid_full:    { title: 'Bill Paid in Full ✅',   msg: `${actor_name} cleared ${description}` },
    past_due_paid:        { title: 'Past Due Cleared ✅',    msg: `${actor_name} paid past due — ${description}` },
    expense_earmarked:    { title: 'Bill Earmarked 🏷️',     msg: `${actor_name} earmarked ${description}` },
    expense_unearlmarked: { title: 'Earmark Removed 🏷️',   msg: `${actor_name} removed earmark on ${description}` },
    transaction_logged:   { title: 'Transaction Logged 💳', msg: `${actor_name}: ${description}` },
    receipt_scanned:      { title: 'Receipt Scanned 📷',    msg: `${actor_name} scanned a receipt — ${description}` },
    transaction_deleted:  { title: 'Transaction Deleted 🗑️', msg: `${actor_name} deleted: ${description}` },
    cash_updated:         { title: 'Balance Updated 🔄',    msg: `${actor_name} updated Available balance` },
    goal_contribution:    { title: 'Goal Contribution 🎯',  msg: `${actor_name} contributed — ${description}` },
    goal_created:         { title: 'New Goal 🎯',           msg: `${actor_name} created a goal: ${description}` },
    preallocation_set:    { title: 'Pre-Allocation Set 💚', msg: `${actor_name} pre-allocated — ${description}` },
  };

  const notif = messages[event_type] || { title: 'Clarity Update 📲', msg: `${actor_name}: ${description}` };

  // Routing logic
  // Critical events (household-level) → both people
  // Everything else → cross-notify only (the other person)
  const criticalEvents = ['expense_paid', 'expense_paid_full', 'past_due_paid', 'paycheck_logged', 'goal_contribution', 'goal_created', 'goal_milestone'];
  const isCritical = criticalEvents.includes(event_type);
  const actorIsJay = actor_id === jay_id;

  const recipients = [];
  if (isCritical) {
    if (jayKey) recipients.push(jayKey);
    if (chariKey) recipients.push(chariKey);
  } else {
    // Cross-notify: only the other person
    if (actorIsJay && chariKey) recipients.push(chariKey);
    if (!actorIsJay && jayKey) recipients.push(jayKey);
  }

  // Deduplicate in case both keys are somehow identical
  const unique = [...new Set(recipients)];

  if (unique.length === 0) {
    return res.status(200).json({ sent: false, reason: 'no recipients — Chari key may not be set yet' });
  }

  await Promise.allSettled(
    unique.map(userKey =>
      fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          user: userKey,
          title: notif.title,
          message: notif.msg,
          sound: 'cashregister',
          priority: isCritical ? 0 : -1, // normal for critical, low for info
        }),
      })
    )
  );

  return res.status(200).json({ sent: true, recipients: unique.length });
}

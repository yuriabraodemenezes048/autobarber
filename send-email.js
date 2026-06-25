// api/send-email.js — Resend transactional email
// Env var required: RESEND_API_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://autobarber-app.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', success: false });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[send-email] RESEND_API_KEY not set');
    return res.status(500).json({ error: 'Email service not configured', success: false });
  }

  const { to, subject, html, from } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing: to, subject, html', success: false });
  }

  const toArr = Array.isArray(to) ? to : [to];

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from || 'AutoBarber <noreply@autobarber-app.vercel.app>',
        to: toArr,
        subject,
        html,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[send-email] Resend error:', data);
      return res.status(r.status).json({ error: data.message || 'Send failed', success: false });
    }
    console.log(`[send-email] Sent to ${toArr.join(', ')} — ID: ${data.id}`);
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('[send-email] Error:', err);
    return res.status(500).json({ error: err.message, success: false });
  }
}

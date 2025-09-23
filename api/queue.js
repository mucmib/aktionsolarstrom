// /api/queue.js – Vercel Serverless Function mit @getbrevo/brevo
import Brevo from "@getbrevo/brevo";

const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !body[k] || String(body[k]).trim()==="");
  if (missing.length) return res.status(400).json({ error: "missing_fields", fields: missing });

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const now = new Date().toISOString().slice(0,10);

  const teamHtml = `
    <h3>Neue Einreichung – ${queueId}</h3>
    <p><b>Datum:</b> ${now}</p>
    <p><b>Absender:in</b><br>
      ${escapeHtml(body.first_name)} ${escapeHtml(body.last_name)}<br>
      ${escapeHtml(body.street)}<br>
      ${escapeHtml(body.sender_zip)} ${escapeHtml(body.sender_city)}<br>
      E-Mail: ${escapeHtml(body.email)}
    </p>
    <p><b>PLZ/Ort für MdB-Ermittlung:</b> ${escapeHtml(body.zip||"")} ${escapeHtml(body.city||"")}</p>
    <p><b>Optionaler MdB-Name:</b> ${escapeHtml(body.mp_name||"")}</p>
    <p><b>Betreff:</b> ${escapeHtml(body.subject)}</p>
    <p><b>Nachricht:</b><br>${escapeHtml(body.message).replace(/\n/g,"<br>")}</p>
  `;

  try {
    // Brevo-Client initialisieren
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // Mail an Team
    await api.sendTransacEmail({
      to: [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL || "no-reply@deinedomain.de", name: "Kampagnen-Formular" },
      subject: `Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml
    });

    // Kopie an Absender:in
    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to: [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL || "no-reply@deinedomain.de", name: "Kampagnen-Formular" },
        subject: `Kopie – Vorgang ${queueId}`,
        htmlContent: `<p>Danke! Wir versenden deinen Brief per Post.</p><p>Vorgangs-ID: <b>${queueId}</b></p>`
      });
    }

    return res.status(200).json({ ok: true, queueId });
  } catch (err) {
    const msg = err?.response?.text || err?.message || String(err);
    return res.status(500).json({ error: "send_failed", message: msg });
  }
});

// /api/queue.js – Vercel Serverless Function (Brevo HTTP API)
import Brevo from "@getbrevo/brevo";

const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

const must = (v) => v && String(v).trim() !== "";
const esc = (s = "") =>
  String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
           .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !must(body[k]));
  if (missing.length) return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });

  if (!process.env.BREVO_API_KEY || !process.env.FROM_EMAIL || !process.env.TEAM_INBOX) {
    return res.status(500).json({
      ok:false, error:"env_missing",
      envState: {
        BREVO_API_KEY: !!process.env.BREVO_API_KEY,
        FROM_EMAIL: !!process.env.FROM_EMAIL,
        TEAM_INBOX: !!process.env.TEAM_INBOX
      }
    });
  }

  const wantsCopy = ["true","on","1","yes"].includes(String(body.copy_to_self).toLowerCase());
  const queueId = Math.random().toString(36).slice(2,8).toUpperCase();
  const today = new Date().toISOString().slice(0,10);

  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
    <p><b>Absender:in</b><br>
      ${esc(body.first_name)} ${esc(body.last_name)}<br>
      ${esc(body.street)}<br>
      ${esc(body.sender_zip)} ${esc(body.sender_city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>PLZ/Ort für MdB-Ermittlung:</b> ${esc(body.zip||"")} ${esc(body.city||"")}</p>
    <p><b>Optionaler MdB-Name:</b> ${esc(body.mp_name||"")}</p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(body.message).replace(/\n/g,"<br>")}</p>
  `;

  const userHtml = `
    <p>Danke für deine Einreichung! Wir haben deinen Brief übernommen.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(body.message).replace(/\n/g,"<br>")}</p>
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) Mail an euer Team (replyTo = Absender, damit ihr direkt zurückschreiben könnt)
    await api.sendTransacEmail({
      to: [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo: { email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject: `Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml
    });

    // 2) Optionale Kopie an Absender:in (immer von der verifizierten FROM_EMAIL)
    if (wantsCopy) {
      await api.sendTransacEmail({
        to: [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject: `Kopie deiner Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, copySent: wantsCopy });
  } catch (err) {
    const status = err?.response?.status;
    let detail = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});

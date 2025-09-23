// /api/queue.js – Diagnose-Version (liefert klare Fehlertexte zurück)
import Brevo from "@getbrevo/brevo";

const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

function must(v){ return v && String(v).trim() !== ""; }

export default allowCors(async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // einfacher Ping zum Test
      return res.status(405).json({ ok:false, error:"method_not_allowed", msg:"Bitte POST verwenden." });
    }

    // Body robust parsen
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
    const missing = required.filter(k => !must(body[k]));
    if (missing.length) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
    }

    // ENV-Check (ohne Werte zu verraten)
    const envState = {
      BREVO_API_KEY: !!process.env.BREVO_API_KEY,
      TEAM_INBOX: !!process.env.TEAM_INBOX,
      FROM_EMAIL: !!process.env.FROM_EMAIL
    };
    if (!envState.BREVO_API_KEY || !envState.TEAM_INBOX || !envState.FROM_EMAIL) {
      return res.status(500).json({ ok:false, error:"env_missing", envState });
    }

    // Brevo vorbereiten
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    const queueId = Math.random().toString(36).slice(2,8).toUpperCase();
    const html = `<p><b>Testlauf</b> Vorgang ${queueId}</p>`;

    // Nur EINE Testmail ans Team schicken (copy_to_self lassen wir weg)
    try {
      await api.sendTransacEmail({
        to: [{ email: process.env.TEAM_INBOX }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
        subject: `Diagnose – Vorgang ${queueId}`,
        htmlContent: html
      });
    } catch (mailErr) {
      const text = mailErr?.response?.text || mailErr?.message || String(mailErr);
      return res.status(502).json({ ok:false, error:"brevo_send_failed", message: text });
    }

    return res.status(200).json({ ok:true, queueId, note:"Diagnose-Version: 1 Mail an TEAM_INBOX gesendet" });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ ok:false, error:"server_crash", message: msg });
  }
});

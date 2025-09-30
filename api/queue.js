// /api/queue.js – Vercel Serverless Function (Brevo HTTP API)
import Brevo from "@getbrevo/brevo";

/** CORS erlauben (optional, aber praktisch) */
const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

/** kleine Helfer */
const must = (v) => v && String(v).trim() !== "";
const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/** Body möglichst robust lesen (JSON erwartet; multipart wird von Vercel NICHT automatisch geparst) */
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  // Wenn bereits als Objekt vorliegt (z. B. durch Middleware)
  return req.body;
}

/** Strings 'true'/'on'/'1'/'yes' in boolean wandeln */
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // 🔹 Body lesen & Felder auf gemeinsame Namen normalisieren
  const raw = readBody(req);

  // Unterstütze beide Varianten deiner Formulare:
  const body = {
    // Empfänger/MdB-Ermittlung
    zip:            raw.zip ?? raw.plz ?? "",
    city:           raw.city ?? raw.ort ?? "",
    mp_name:        raw.mp_name ?? raw.abgeordneter ?? "",

    // Absender
    first_name:     raw.first_name ?? raw.vorname ?? "",
    last_name:      raw.last_name ?? raw.nachname ?? "",
    email:          raw.email ?? "",
    street:         raw.street ?? raw.strasse ?? "",
    sender_zip:     raw.sender_zip ?? raw.plz_abs ?? "",
    sender_city:    raw.sender_city ?? raw.ort_abs ?? "",

    // Brief
    subject:        raw.subject ?? "",
    message:        raw.message ?? "",

    // Optionen
    consent_print:  toBool(raw.consent_print ?? raw.postversand ?? false),
    copy_to_self:   toBool(raw.copy_to_self ?? raw.copy ?? false),
  };

  // Pflichtfelder prüfen
  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !must(body[k]));
  if (missing.length) {
    return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
  }

  // Environment prüfen
  if (!process.env.BREVO_API_KEY || !process.env.FROM_EMAIL || !process.env.TEAM_INBOX) {
    return res.status(500).json({
      ok:false, error:"env_missing",
      envState:{
        BREVO_API_KEY: !!process.env.BREVO_API_KEY,
        FROM_EMAIL:    !!process.env.FROM_EMAIL,
        TEAM_INBOX:    !!process.env.TEAM_INBOX
      }
    });
  }

  // 🔹 Platzhalter vorbereiten
  const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";

  // Brieftext mit Platzhaltern → ersetzen (erst ersetzen, dann escapen & Zeilenumbrüche zu <br>)
  let finalMessage = body.message;
  finalMessage = finalMessage.replace("{Anrede_Name}", anredeName);
  finalMessage = finalMessage.replace("{Vorname}", body.first_name);
  finalMessage = finalMessage.replace("{Nachname}", body.last_name);
  finalMessage = finalMessage.replace("{Straße}", body.street);
  finalMessage = finalMessage.replace("{PLZ}", body.sender_zip);
  finalMessage = finalMessage.replace("{Ort}", body.sender_city);

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // 🔹 E-Mail-Inhalte
  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
    <p><b>Absender:in</b><br>
      ${esc(body.first_name)} ${esc(body.last_name)}<br>
      ${esc(body.street)}<br>
      ${esc(body.sender_zip)} ${esc(body.sender_city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>PLZ/Ort für MdB-Ermittlung:</b> ${esc(body.zip)} ${esc(body.city)}</p>
    <p><b>Optionaler MdB-Name:</b> ${esc(body.mp_name)}</p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext (ersetzte Platzhalter):</b><br>${esc(finalMessage).replace(/\n/g,"<br>")}</p>
  `;

  const userHtml = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(finalMessage).replace(/\n/g,"<br>")}</p>
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) Mail an euer Team (Reply-To = Absender:in, damit Antworten direkt an sie gehen)
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml
    });

    // 2) Optional Kopie an Absender:in – immer vom verifizierten FROM_EMAIL
    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, copySent: body.copy_to_self });
  } catch (err) {
    // detaillierte Fehlerausgabe
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});

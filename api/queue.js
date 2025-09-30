// /api/queue.js – Vercel Serverless Function (Brevo HTTP API + PDF)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import { Readable } from "stream";

/** CORS erlauben (praktisch via Formular/Fetch) */
const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

/** Helfer */
const must = (v) => v && String(v).trim() !== "";
const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

/** Body robust lesen (Vercel liefert uns req.body ggf. als Objekt oder String) */
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}

/** Promise, das einen PDF-Buffer erzeugt */
function buildPdf({ queueId, subject, message, first_name, last_name, street, sender_zip, sender_city }) {
  return new Promise((resolve, reject) => {
    try{
      const doc = new PDFDocument({ size: "A4", margins: { top: 72, left: 56, right: 56, bottom: 72 } });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Schrift
      doc.fontSize(11);

      // Absender (unten im Brief – im Text enthalten)

      // Empfänger & Anrede & Nachricht (der message-Text ist bereits mit Platzhaltern ersetzt)
      const lines = String(message || "").split(/\r?\n/);
      lines.forEach((ln, i) => {
        if (i === 0) doc.moveDown(0.5); // kleiner Abstand am Anfang
        doc.text(ln, { continued: false });
      });

      // Fußzeile mit Vorgangs-ID auf Seite 1
      const footer = `Vorgangs-ID: ${queueId}`;
      const y = doc.page.height - doc.page.margins.bottom + 20;
      doc.fontSize(9).fillColor("#666").text(footer, doc.page.margins.left, y, { align: "left" });

      doc.end();
    }catch(e){ reject(e); }
  });
}

export default allowCors(async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"method_not_allowed" });
    }

    // 🔹 Body lesen & Felder normalisieren
    const raw = readBody(req);

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

    // Fallbacks: Absender-PLZ/Ort aus oberer PLZ/Ort übernehmen, falls leer
    body.sender_zip  = body.sender_zip  || body.zip;
    body.sender_city = body.sender_city || body.city;

    // Pflichtfelder prüfen
    const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
    const missing = required.filter(k => !must(body[k]));
    if (missing.length) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
    }

    // ENV prüfen
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

    // 🔹 Platzhalter ersetzen
    const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";

    let finalMessage = body.message;
    finalMessage = finalMessage.replace("{Anrede_Name}", anredeName);
    finalMessage = finalMessage.replace("{Anrede}", anredeName);
    finalMessage = finalMessage.replace("{Vorname}", body.first_name);
    finalMessage = finalMessage.replace("{Nachname}", body.last_name);
    finalMessage = finalMessage.replace("{Straße}", body.street);
    finalMessage = finalMessage.replace("{PLZ}", body.sender_zip);
    finalMessage = finalMessage.replace("{Ort}", body.sender_city);

    const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const today   = new Date().toISOString().slice(0,10);

    // 🔹 PDF bauen
    const pdfBuffer = await buildPdf({
      queueId,
      subject: body.subject,
      message: finalMessage,
      first_name: body.first_name,
      last_name: body.last_name,
      street: body.street,
      sender_zip: body.sender_zip,
      sender_city: body.sender_city
    });
    const pdfBase64 = pdfBuffer.toString("base64");
    const pdfName = `Brief_${queueId}.pdf`;

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

    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) Mail an Team (mit PDF), Reply-To: Absender:in
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [{ name: pdfName, content: pdfBase64 }]
    });

    // 2) Optional Kopie an Absender:in (mit gleichem PDF)
    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml,
        attachment: [{ name: pdfName, content: pdfBase64 }]
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, copySent: body.copy_to_self });

  } catch (err) {
    const status = err?.response?.status || 500;
    let detail   = err?.response?.text || err?.message || String(err);
    try {
      if (err?.response?.body) detail = JSON.stringify(err.response.body);
    } catch {}
    console.error("queue.js top-level error:", status, detail);
    return res.status(status >= 400 ? status : 500).json({
      ok:false, error:"server_error", status, detail
    });
  }
});








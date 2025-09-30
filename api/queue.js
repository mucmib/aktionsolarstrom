// /api/queue.js – Vercel Serverless Function (Brevo HTTP API + PDF)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";

/** CORS erlauben */
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
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}

/** PDF schöner setzen: Absätze, Listen-Einzug, Adressblock-Luft, Fußzeile */
function buildPdf({ queueId, message }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 72, left: 56, right: 56, bottom: 72 }
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      doc.fontSize(11);
      // Grund-Zeilenabstand
      doc.lineGap(2);

      const text = String(message || "").trim();

      // Absätze an Leerzeilen erkennen
      const paragraphs = text.split(/\r?\n\r?\n/);

      paragraphs.forEach((p, idx) => {
        const pTrim = p.trim();

        // Heuristik: erster Absatz enthält Empfängeradresse → etwas mehr Luft danach
        const isAddressBlock =
          idx === 0 && /deutscher bundestag/i.test(pTrim);

        // Einzug für nummerierte Listen
        const isList = /^\d+\.\s/.test(pTrim);

        const opts = { width: pageWidth, align: "left" };
        if (isList) opts.indent = 12;

        doc.text(pTrim, opts);

        // Absatzabstände
        if (isAddressBlock) {
          doc.moveDown(0.8);
        } else {
          doc.moveDown(0.5);
        }
      });

      // Fußzeile (Seite 1)
      const footer = `Vorgangs-ID: ${queueId}`;
      const y = doc.page.height - doc.page.margins.bottom + 20;
      doc.fontSize(9).fillColor("#666").text(footer, doc.page.margins.left, y, { align: "left", width: pageWidth });

      doc.end();
    } catch (e) { reject(e); }
  });
}

export default allowCors(async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"method_not_allowed" });
    }

    // Body & Normalisierung
    const raw = readBody(req);
    const body = {
      zip:            raw.zip ?? raw.plz ?? "",
      city:           raw.city ?? raw.ort ?? "",
      mp_name:        raw.mp_name ?? raw.abgeordneter ?? "",
      first_name:     raw.first_name ?? raw.vorname ?? "",
      last_name:      raw.last_name ?? raw.nachname ?? "",
      email:          raw.email ?? "",
      street:         raw.street ?? raw.strasse ?? "",
      sender_zip:     raw.sender_zip ?? raw.plz_abs ?? "",
      sender_city:    raw.sender_city ?? raw.ort_abs ?? "",
      subject:        raw.subject ?? "",
      message:        raw.message ?? "",
      consent_print:  toBool(raw.consent_print ?? raw.postversand ?? false),
      copy_to_self:   toBool(raw.copy_to_self ?? raw.copy ?? false),
    };
    body.sender_zip  = body.sender_zip  || body.zip;
    body.sender_city = body.sender_city || body.city;

    const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
    const missing = required.filter(k => !must(body[k]));
    if (missing.length) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
    }

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

    // Platzhalter ersetzen
    const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";
    let finalMessage = body.message
      .replace("{Anrede_Name}", anredeName)
      .replace("{Anrede}", anredeName)
      .replace("{Vorname}", body.first_name)
      .replace("{Nachname}", body.last_name)
      .replace("{Straße}", body.street)
      .replace("{PLZ}", body.sender_zip)
      .replace("{Ort}", body.sender_city);

    const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const today   = new Date().toISOString().slice(0,10);

    // PDF bauen (schönere Formatierung)
    const pdfBuffer = await buildPdf({ queueId, message: finalMessage });
    const pdfBase64 = pdfBuffer.toString("base64");
    const pdfName = `Brief_${queueId}.pdf`;

    // E-Mail-Inhalte
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

    // Team
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [{ name: pdfName, content: pdfBase64 }]
    });

    // Kopie an Absender:in (optional)
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
    try { if (err?.response?.body) detail = JSON.stringify(err.response.body); } catch {}
    console.error("queue.js error:", status, detail);
    return res.status(status >= 400 ? status : 500).json({ ok:false, error:"server_error", status, detail });
  }
});

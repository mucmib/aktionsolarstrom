// /api/queue.js – Vercel Serverless Function (Brevo HTTP API + PDF-Erzeugung)
import Brevo from "@getbrevo/brevo";

/** CORS erlauben */
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
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

/** Body robust lesen */
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}

/** finalMessage in Adresse (Block 1) und Rest (ab Block 2) splitten */
function splitRecipientAndBody(finalMessage) {
  const parts = String(finalMessage || "").split(/\n{2,}/); // Blöcke durch Leerzeilen
  const recipientBlock = (parts[0] || "").trim(); // {MdB_Name_und_Adresse} inkl. "Deutscher Bundestag"
  const bodyBlocks = parts.slice(1).join("\n\n").trim(); // Anrede + Text
  return { recipientBlock, bodyText: bodyBlocks };
}

/** PDF erzeugen (DIN 5008-ish) */
async function generatePdf({ body, finalMessage, queueId }) {
  // pdfkit dynamisch laden (ESM-kompatibel auf Vercel)
  const PDFDocument = (await import("pdfkit")).default;

  // Maße
  const A4 = { w: 595.28, h: 841.89 };         // pt
  const cm = (x) => x * 28.346;                // 1 cm in pt
  const marginL = cm(2.5), marginR = cm(2.5);  // 2,5 cm
  const marginT = cm(2.5), marginB = cm(2.0);

  // Adressfenster: Oberkante ~4,5 cm von oben (DIN 5008), linke Kante = linker Rand
  const addrTop = cm(4.5);
  const contentWidth = A4.w - marginL - marginR;

  // Inhalte aufbereiten
  const { recipientBlock, bodyText } = splitRecipientAndBody(finalMessage);
  const today = new Date().toLocaleDateString("de-DE");
  const absenderBlock = [
    `${body.first_name} ${body.last_name}`.trim(),
    String(body.street || "").trim(),
    `${body.sender_zip || ""} ${body.sender_city || ""}`.trim()
  ].filter(Boolean).join("\n");

  // PDF erstellen & in Buffer sammeln
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: marginT, left: marginL, right: marginR, bottom: marginB }
  });

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Schriften
  doc.font("Helvetica").fontSize(11);

  // Kopfzeile (klein, Grau): Absender rechts oben
  doc.fillColor("#555")
     .fontSize(9)
     .text(absenderBlock, marginL, marginT - cm(1.0), { width: contentWidth, align: "right" });

  // Empfängeradresse im Fensterbereich
  doc.fillColor("#000").fontSize(11);
  doc.text(recipientBlock, marginL, addrTop, { width: contentWidth });

  // Datum rechtsbündig unter Adresse
  doc.moveDown(1.2);
  doc.text(today, { align: "right" });

  // Betreff
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text(body.subject || "Ihr Schreiben", { width: contentWidth });
  doc.font("Helvetica");

  // Leerraum vor Fließtext
  doc.moveDown(0.8);

  // Haupttext (Anrede + Inhalt)
  doc.text(bodyText, { width: contentWidth });

  // Grußformel + Unterschriftsblock
  doc.moveDown(2);
  doc.text("Mit freundlichen Grüßen");
  doc.moveDown(1);
  doc.text(absenderBlock);

  // Fuß: Vorgangs-ID
  doc.moveDown(2);
  doc.fontSize(9).fillColor("#666").text(`Vorgangs-ID: ${queueId}`);

  doc.end();
  const pdfBuffer = await done;
  const fileName = `Brief_${queueId}.pdf`;
  return { buffer: pdfBuffer, name: fileName, mime: "application/pdf" };
}

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // 🔹 Body lesen & Felder normalisieren
  const raw = readBody(req);
  const body = {
    // Empfänger/MdB-Ermittlung (nur info; Briefkopf kommt aus message-Block 1)
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

  // Fallbacks für Absender-PLZ/-Ort aus oberen Feldern
  body.sender_zip  = body.sender_zip  || body.zip;
  body.sender_city = body.sender_city || body.city;

  // Pflichtfelder
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

  // 🔹 Platzhalter in message serverseitig sicher ersetzen
  const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";

  let finalMessage = body.message;
  finalMessage = finalMessage.replace("{Anrede_Name}", anredeName)
                             .replace("{Anrede}", anredeName)
                             .replace("{Vorname}", body.first_name)
                             .replace("{Nachname}", body.last_name)
                             .replace("{Straße}", body.street)
                             .replace("{PLZ}", body.sender_zip)
                             .replace("{Ort}", body.sender_city);

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // 🔹 PDF erzeugen
  let pdfAttachment = null;
  try {
    const { buffer, name, mime } = await generatePdf({ body, finalMessage, queueId });
    pdfAttachment = {
      name,
      content: buffer.toString("base64"),
      type: mime
    };
  } catch (e) {
    // PDF ist "nice-to-have": wir lassen Mail trotzdem raus, loggen aber den Fehler
    console.error("PDF generation failed:", e);
  }

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
    ${pdfAttachment ? '<p><i>PDF im Anhang (druckfertig)</i></p>' : '<p><i>PDF konnte nicht erzeugt werden</i></p>'}
  `;

  const userHtml = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(finalMessage).replace(/\n/g,"<br>")}</p>
    ${pdfAttachment ? '<p><i>PDF-Kopie im Anhang</i></p>' : ''}
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) Mail an euer Team (Reply-To = Absender:in)
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachments: pdfAttachment ? [pdfAttachment] : []
    });

    // 2) Optional Kopie an Absender:in
    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml,
        attachments: pdfAttachment ? [pdfAttachment] : []
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, copySent: body.copy_to_self, pdf: !!pdfAttachment });
  } catch (err) {
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});


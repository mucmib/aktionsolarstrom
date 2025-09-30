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

/** PDF mit Briefkopf: Absender rechts oben, darunter Datum & Vorgangs-ID.
 *  Absätze und nummerierte Listen werden lesbar gesetzt. */
function buildPdf({ queueId, message, sender, dateDe }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 72, left: 56, right: 56, bottom: 72 } // 2.5cm / 2cm
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ===== Briefkopf rechts oben =====
      const headerWidth = 220; // Breite der rechten Spalte
      const headerX = doc.page.width - doc.page.margins.right - headerWidth;
      const headerY = doc.page.margins.top;

      const headerLines = [
        `${sender.name}`,
        `${sender.street}`,
        `${sender.zip} ${sender.city}`,
        "", // Leerzeile
        `${dateDe}`,
        `Vorgangs-ID: ${queueId}`
      ].filter(Boolean).join("\n");

      doc.fontSize(10).fillColor("#000");
      doc.text(headerLines, headerX, headerY, { width: headerWidth, align: "right" });

      // Y-Position unterhalb des Headers bestimmen
      const headerHeight = doc.heightOfString(headerLines, { width: headerWidth, align: "right" });
      const startY = Math.max(doc.page.margins.top + headerHeight + 28, doc.page.margins.top + 110);

      // ===== Fließtext links =====
      doc.fontSize(11).lineGap(2).fillColor("#000");
      doc.y = startY;

      const text = String(message || "").trim();
      const paragraphs = text.split(/\r?\n\r?\n/);

      paragraphs.forEach((p, idx) => {
        const pTrim = p.trim();

        // Einzug für nummerierte Listen
        const isList = /^\d+\.\s/.test(pTrim);
        const options = { width: usableWidth, align: "left" };
        if (isList) options.indent = 12;

        // Erste Box nach Adressblock etwas mehr Luft
        const isFirst = idx === 0;
        doc.text(pTrim, options);
        doc.moveDown(isFirst ? 0.8 : 0.5);
      });

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
    // Fallbacks
    body.sender_zip  = body.sender_zip  || body.zip;
    body.sender_city = body.sender_city || body.city;

    // Pflichtfelder
    const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
    const missing = required.filter(k => !must(body[k]));
    if (missing.length) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
    }

    // Env
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
    const dateDe  = new Date().toLocaleDateString("de-DE", { day:"2-digit", month:"long", year:"numeric" });

    // PDF erzeugen (mit Briefkopf rechts)
    const pdfBuffer = await buildPdf({
      queueId,
      message: finalMessage,
      dateDe,
      sender: {
        name: `${body.first_name} ${body.last_name}`.trim(),
        street: body.street,
        zip: body.sender_zip,
        city: body.sender_city
      }
    });
    const pdfBase64 = pdfBuffer.toString("base64");
    const pdfName = `Brief_${queueId}.pdf`;

    // E-Mail-Inhalte
    const todayISO = new Date().toISOString().slice(0,10);
    const teamHtml = `
      <h2>Neue Einreichung – ${esc(queueId)}</h2>
      <p><b>Datum:</b> ${esc(todayISO)} (${esc(dateDe)})</p>
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

    // 1) Team-Mail mit PDF
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [{ name: pdfName, content: pdfBase64 }]
    });

    // 2) Optional Kopie an Absender:in
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



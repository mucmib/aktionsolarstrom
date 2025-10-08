// /api/queue.js – Vercel Serverless Function
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";

/** --- CORS (praktisch für lokale/andere Origins) --- */
const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

/** --- kleine Helfer --- */
const must = (v) => v && String(v).trim() !== "";
const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());
const mm = (x) => (x * 72) / 25.4;

/** --- NEU: Fenster-Koordinaten + Absenderzeile im Fenster --- */
const WINDOW = {
  left: mm(20),       // Fenster beginnt 20 mm vom linken Blattrand
  topFromTop: mm(45), // Fenster beginnt 45 mm von oben
  width: mm(90),      // Fensterbreite 90 mm
  height: mm(45),     // Fensterhöhe 45 mm
};
function drawSenderLine(doc, senderLine) {
  if (!senderLine) return;
  // Wir arbeiten hier – wie im restlichen Code – mit y von oben nach unten.
  const padX = mm(2);          // kleiner Innenabstand links/rechts
  const padY = mm(3);          // 3 mm unter Fensteroberkante
  const x = WINDOW.left + padX;
  const y = WINDOW.topFromTop + padY;
  const w = WINDOW.width - padX * 2;

  doc.save();
  doc.fontSize(8).fillColor("#555");
  doc.text(String(senderLine), x, y, { width: w, ellipsis: true });
  doc.restore();
}

/** Datum auf Deutsch */
function formatDateDE(d = new Date()) {
  const m = [
    "Januar","Februar","März","April","Mai","Juni",
    "Juli","August","September","Oktober","November","Dezember"
  ];
  return `${d.getDate()}. ${m[d.getMonth()]} ${d.getFullYear()}`;
}

/** ersten Anschriften-Absatz aus dem Nachrichtentext entfernen */
function stripRecipientParagraph(txt = "") {
  const parts = String(txt).trim().split(/\n{2,}/);
  if (!parts.length) return txt;
  const p0 = parts[0] || "";
  const looksLikeAddress =
    /Platz der Republik/i.test(p0) ||
    /Deutscher Bundestag/i.test(p0) ||
    /\b\d{5}\s+Berlin\b/i.test(p0);
  if (looksLikeAddress) parts.shift();
  return parts.join("\n\n").trim();
}

/** PDF bauen – gibt Buffer zurück */
async function buildLetterPDF({
  queueId,
  sender,        // { name, street, zip, city }
  recipient,     // { name, address } address ggf. mehrzeilig
  subject,
  bodyText,      // reine Briefinhalte inkl. Anrede + Grußformel
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(18), left: mm(20), right: mm(20), bottom: mm(18) },
    bufferPages: true,
  });

  // Buffer einsammeln
  const chunks = [];
  const pdfDone = new Promise((resolve) => {
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  // Fonts
  doc.font("Times-Roman").fontSize(11);

  const pageWidth  = doc.page.width;
  const usableLeft = doc.page.margins.left;
  const usableRight= pageWidth - doc.page.margins.right;
  const usableWidth= usableRight - usableLeft;

  // --- Header rechts oben: Absender + Datum + Vorgangs-ID ---
  const senderBlock = [
    sender.name,
    sender.street,
    `${sender.zip} ${sender.city}`,
    "",
    formatDateDE(new Date()),
    `Vorgangs-ID: ${queueId}`,
  ].filter(Boolean).join("\n");

  doc.text(senderBlock, usableLeft, mm(15), {
    width: usableWidth, align: "right"
  });

  // --- NEU: Absenderzeile im Fensterbereich (klein, grau) ---
  const senderLine = [ sender.name, sender.street, `${sender.zip} ${sender.city}` ]
    .filter(Boolean)
    .join(" · ");
  drawSenderLine(doc, senderLine);

  // --- Empfänger-Anschrift links, für Fensterkuvert ---
  // Address mit "Deutscher Bundestag" sicherstellen
  const addrLines = [];
  if (recipient.name) addrLines.push(recipient.name);
  const addr = String(recipient.address || "").replace(/\s*\n\s*/g, "\n").trim();
  const hasBundestag = /Deutscher Bundestag/i.test(addr);
  if (!hasBundestag) addrLines.push("Deutscher Bundestag");
  if (addr) addrLines.push(...addr.split("\n"));
  const recipientBlock = addrLines.join("\n");

  const addressX = usableLeft;
  const addressY = mm(50);          // ~ 50 mm von oben (liegt im Fenster)
  const addressW = mm(85);          // ~ 85 mm breit (Fenster)
  doc.text(recipientBlock, addressX, addressY, { width: addressW });

  // --- Brieftext (ohne Anschriften-Absatz) ---
  const bodyStartY = addressY + doc.heightOfString(recipientBlock, { width: addressW }) + mm(10);

  // Betreff (optional sichtbar)
  if (must(subject)) {
    doc.moveDown(0.5);
    doc.font("Times-Bold").text(subject, usableLeft, bodyStartY, { width: usableWidth });
    doc.font("Times-Roman");
  }

  // Fließtext (Anrede + Inhalt + Gruß + Signatur) – PDFKit kümmert sich um Umbrüche
  const cleanBody = stripRecipientParagraph(bodyText || "");
  const yAfterSubject = must(subject)
    ? bodyStartY + doc.heightOfString(subject, { width: usableWidth }) + mm(2)
    : bodyStartY;

  doc.text(cleanBody, usableLeft, yAfterSubject, {
    width: usableWidth,
    align: "left",
    lineGap: 2,
  });

  // Ende
  doc.end();
  return pdfDone;
}

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // Body lesen & vereinheitlichen
  const raw = readBody(req);
  const body = {
    // Empfänger/MdB-Ermittlung (von der Seite)
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

  // Fallbacks: Absender-PLZ/-Ort aus oberen Feldern ziehen
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

  // Platzhalter ersetzen
  const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";

  let finalMessage = body.message;
  finalMessage = finalMessage.replace("{Anrede_Name}", anredeName);
  finalMessage = finalMessage.replace("{Anrede}",       anredeName);
  finalMessage = finalMessage.replace("{Vorname}",      body.first_name);
  finalMessage = finalMessage.replace("{Nachname}",     body.last_name);
  finalMessage = finalMessage.replace("{Straße}",       body.street);
  finalMessage = finalMessage.replace("{PLZ}",          body.sender_zip);
  finalMessage = finalMessage.replace("{Ort}",          body.sender_city);

  // Empfänger-Block (nur für PDF; E-Mail lässt den Text wie er ist)
  const recipient = {
    name:    anredeName, // i. d. R. „Vorname Nachname“ – okay für Block
    address: "Platz der Republik 1\n11011 Berlin", // Bundestagsadresse
  };

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // PDF erzeugen
  const pdfBuffer = await buildLetterPDF({
    queueId,
    sender: {
      name: `${body.first_name} ${body.last_name}`.trim(),
      street: body.street,
      zip: body.sender_zip,
      city: body.sender_city,
    },
    recipient,
    subject: body.subject,
    bodyText: finalMessage, // enthält Anrede + Inhalt + Gruß + Signatur
  });

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

  const pdfBase64 = pdfBuffer.toString("base64");
  const pdfName   = `Brief_${queueId}.pdf`;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) Mail an euer Team (mit PDF)
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [{ name: pdfName, content: pdfBase64 }]
    });

    // 2) Optional Kopie an Absender:in (mit PDF)
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
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});









// Serverless Function
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";

/** --- CORS --- */
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
const mm = (x) => (x * 72) / 25.4;

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

/** --- Layout-Konstanten --- */
const WINDOW = { left: mm(20), topFromTop: mm(45), width: mm(90), height: mm(45) };

/** Schriftgrößen zentral */
const FONT = {
  header: 12,      // Absenderblock rechts oben
  body:   12,      // Empfänger + Betreff + Fließtext (Basis)
  senderLine: 7.5, // kleine Zeile über dem Fenster
};

function drawSenderLine(doc, senderLine) {
  if (!senderLine) return;
  const padX = mm(2);
  const padY = mm(1.5);
  const x = WINDOW.left + padX;
  const y = WINDOW.topFromTop + padY;
  const w = WINDOW.width - padX * 2;
  doc.save();
  doc.fontSize(FONT.senderLine).fillColor("#555");
  doc.text(String(senderLine), x, y, { width: w, ellipsis: true });
  doc.restore();
}

/** Datum auf Deutsch */
function formatDateDE(d = new Date()) {
  const m = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  return `${d.getDate()}. ${m[d.getMonth()]} ${d.getFullYear()}`;
}

/** ersten Anschriften-Absatz entfernen */
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

/** Text behutsam normalisieren (Absätze bleiben erhalten) */
function normalizeLetterText(s = "") {
  return String(s || "")
    .replace(/\r\n?/g, "\n")    // einheitliche Zeilenenden
    .replace(/[ \t]+\n/g, "\n") // Space vor Zeilenumbruch weg
    .replace(/\n{3,}/g, "\n\n") // 3+ Leerzeilen -> genau 2 (Absätze!)
    .replace(/[ \t]{2,}/g, " ") // Mehrfachspaces
    .replace(/^\n+|\n+$/g, ""); // führende/abschließende Leerzeilen
}

/** --- Anrede-Helfer --- */
const FEMALE = new Set(["anna","sabine","ursula","katrin","claudia","renate","petra","britta","heike","stefanie","julia","christine","lisa","marie","monika","andrea","martina","sandra","nicole","angelika","eva","kathrin","karin","bettina","svenja","ricarda","elisabeth","maria","linda","sarah","jamila"]);
const MALE   = new Set(["hans","peter","wolfgang","thomas","michael","stefan","andreas","markus","martin","frank","jürgen","juergen","klaus","christian","alexander","lars","tobias","sebastian","uwe","ulrich","paul","max","jan","georg","rolf","rainer","christoph","bernd"]);
function splitName(full = "") {
  const s = String(full).replace(/\b(Dr\.?|Prof\.?|MdB)\b/gi, "").replace(/\s+/g, " ").trim();
  const p = s.split(" ");
  return { first: p[0] || "", last: p[p.length - 1] || "", raw: s };
}
function guessGender(first = "") {
  const f = String(first).toLowerCase();
  if (FEMALE.has(f)) return "f";
  if (MALE.has(f)) return "m";
  return null;
}
function buildPoliteSalutation(name = "", fallback = "Sehr geehrte Damen und Herren,") {
  const { first, last } = splitName(name);
  const g = guessGender(first);
  const withComma = (s) => (/,\s*$/.test(s) ? s : s + ",");
  if (g === "m") return withComma(`Sehr geehrter Herr ${last || first}`);
  if (g === "f") return withComma(`Sehr geehrte Frau ${last || first}`);
  return withComma(fallback.replace(/,\s*$/, ""));
}

/** Anredezeilen wie „Sehr geehrte/r {Anrede_Name},“ durch korrekte Anrede ersetzen */
function escapeRegExp(str=""){ return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function enforcePoliteSalutation(text, polite, name) {
  if (!text) return text;
  let s = String(text);
  const nameOrToken = name ? `(?:${escapeRegExp(name)}|\\{Anrede_Name\\})` : "\\{Anrede_Name\\}";
  const variants = [
    new RegExp(`(^|\\n)\\s*Sehr\\s+geehrte[\\/:*]r\\s+${nameOrToken}\\s*,?`, "i"), // geehrte/r, geehrte:r, geehrte*r
    new RegExp(`(^|\\n)\\s*Sehr\\s+geehrte\\s+${nameOrToken}\\s*,?`, "i"),         // „Sehr geehrte {Name},“
    new RegExp(`(^|\\n)\\s*Sehr\\s+geehrter\\s+${nameOrToken}\\s*,?`, "i"),        // „Sehr geehrter {Name},“
  ];
  for (const rx of variants) s = s.replace(rx, `$1${polite}`);
  return s;
}

/** --- PDF-Erstellung --- */
async function buildLetterPDF({
  queueId, sender, recipient, subject, bodyText
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(18), left: mm(20), right: mm(20), bottom: mm(18) },
    bufferPages: true,
  });

  const chunks = [];
  const pdfDone = new Promise((resolve) => {
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  doc.font("Times-Roman");

  const pageWidth   = doc.page.width;
  const usableLeft  = doc.page.margins.left;
  const usableRight = pageWidth - doc.page.margins.right;
  const usableWidth = usableRight - usableLeft;

  // Header rechts oben (Absenderblock)
  const senderBlock = [
    sender.name,
    sender.street,
    `${sender.zip} ${sender.city}`,
    "",
    formatDateDE(new Date()),
    `Vorgangs-ID: ${queueId}`,
  ].filter(Boolean).join("\n");

  doc.fontSize(FONT.header).text(senderBlock, usableLeft, mm(15), {
    width: usableWidth, align: "right"
  });

  // Kleine Absenderzeile im Fenster
  const senderLine = [ sender.name, sender.street, `${sender.zip} ${sender.city}` ]
    .filter(Boolean).join(" · ");
  drawSenderLine(doc, senderLine);

  // Empfängeranschrift im Fenster
  const addrLines = [];
  if (recipient.name) addrLines.push(recipient.name);
  const addr = String(recipient.address || "").replace(/\s*\n\s*/g, "\n").trim();
  const hasBundestag = /Deutscher Bundestag/i.test(addr);
  if (!hasBundestag) addrLines.push("Deutscher Bundestag");
  if (addr) addrLines.push(...addr.split("\n"));
  const recipientBlock = addrLines.join("\n");

  const addressX = usableLeft;
  const addressY = mm(52);
  const addressW = mm(85);
  doc.fontSize(FONT.body).text(recipientBlock, addressX, addressY, { width: addressW });

  // Startposition unter der Anschrift
  const bodyStartY =
    addressY + doc.heightOfString(recipientBlock, { width: addressW }) + mm(10);

  // Betreff-Höhe (Basis)
  let subjectHeight = 0;
  if (must(subject)) {
    subjectHeight = doc.heightOfString(subject, { width: usableWidth, font: "Times-Bold", fontSize: FONT.body });
  }
  const yAfterSubject = must(subject) ? bodyStartY + subjectHeight + mm(2) : bodyStartY;

  // Verbleibender Platz bis Unterkante
  const availableHeight = (doc.page.height - doc.page.margins.bottom) - yAfterSubject;

  // Fließtext vorbereiten
  const cleanBody = stripRecipientParagraph(bodyText || "");

  // --- Dynamisches „Fit to One Page“ ---
  const MIN_SIZE = 9.5;
  const BASE_SIZE = FONT.body; // 12
  let bodySize = BASE_SIZE;
  let lineGap  = 2;
  let measured = doc.heightOfString(cleanBody, { width: usableWidth, lineGap, fontSize: bodySize });

  while (measured > availableHeight && (lineGap > 0 || bodySize > MIN_SIZE)) {
    if (lineGap > 0) lineGap = Math.max(0, lineGap - 0.25);
    else bodySize = Math.max(MIN_SIZE, bodySize - 0.25);
    measured = doc.heightOfString(cleanBody, { width: usableWidth, lineGap, fontSize: bodySize });
  }

  // Betreff
  if (must(subject)) {
    doc.moveDown(0.5);
    doc.font("Times-Bold").fontSize(bodySize)
       .text(subject, usableLeft, bodyStartY, { width: usableWidth });
    doc.font("Times-Roman");
  }

  // Fließtext
  doc.fontSize(bodySize).text(cleanBody, usableLeft, yAfterSubject, {
    width: usableWidth,
    align: "left",
    lineGap,
  });

  doc.end();
  return pdfDone;
}

/** --- Handler --- */
export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

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

  // Anrede bauen
  const nameForSalutation = must(body.mp_name) ? String(body.mp_name).trim() : "";
  const politeSalutation  = nameForSalutation
    ? buildPoliteSalutation(nameForSalutation)
    : "Sehr geehrte Damen und Herren,";

  // Platzhalter ersetzen
  let finalMessage = body.message;
  finalMessage = finalMessage.split("{Anrede}").join(politeSalutation);
  finalMessage = finalMessage.split("{Anrede_Name}").join(nameForSalutation || "");
  finalMessage = finalMessage.split("{Vorname}").join(body.first_name);
  finalMessage = finalMessage.split("{Nachname}").join(body.last_name);
  finalMessage = finalMessage.split("{Straße}").join(body.street);
  finalMessage = finalMessage.split("{PLZ}").join(body.sender_zip);
  finalMessage = finalMessage.split("{Ort}").join(body.sender_city);

  // ⚙️ Falls der Text eine „Sehr geehrte/r {Anrede_Name},“-Zeile enthält: korrekt überschreiben
  finalMessage = enforcePoliteSalutation(finalMessage, politeSalutation, nameForSalutation);

  // Sanft normalisieren (Absätze bleiben)
  finalMessage = normalizeLetterText(finalMessage);

  const recipient = {
    name:    nameForSalutation || "Mitglied des Deutschen Bundestages",
    address: "Platz der Republik 1\n11011 Berlin",
  };

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

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
    bodyText: finalMessage,
  });

  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
    <p><b>Absender:in</b><br>
      ${esc(body.first_name)} ${esc(body.last_name)}<br>
      ${esc(body.street)}<br>
      ${esc(body.sender_zip)} ${esc(body.sender_city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>MdB:</b> ${esc(body.mp_name)}</p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(finalMessage).replace(/\n/g,"<br>")}</p>
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

    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [{ name: pdfName, content: pdfBase64 }]
    });

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

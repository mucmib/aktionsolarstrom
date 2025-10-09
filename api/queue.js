// /api/queue.js – Vercel Serverless Function
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import archiver from "archiver";             // ← NEU (für ZIP)
import { PassThrough } from "stream";
import { kv } from "@vercel/kv";

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
  header: 12,
  body:   11,
  senderLine: 7.5,
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

/** Adress-Absatz entfernen */
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

/** Anrede-Helfer */
const FEMALE = new Set(["anna","sabine","ursula","katrin","claudia","renate","petra","britta","heike","stefanie","julia","christine","lisa","marie","monika","andrea","martina","sandra","nicole","angelika","eva","kathrin","karin","bettina","svenja","ricarda","elisabeth","maria","linda","sarah"]);
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

/** ——— NEU: Empfänger-Helfer ——— */
function normalizeBundestagAddress(addr) {
  const lines = String(addr || "").split("\n").map(s=>s.trim()).filter(Boolean);
  const hasHeader = lines.some(l=>/^deutscher\s+bundestag$/i.test(l));
  const body = hasHeader ? lines : ["Deutscher Bundestag", ...lines];
  const out=[]; for(const l of body){ if(out[out.length-1]!==l) out.push(l); }
  return out.join("\n");
}

function recipientToAddressBlock(recipient) {
  const name = recipient.mdb_name || recipient.name || "";
  const addr = normalizeBundestagAddress(
    recipient.bundestag_address || recipient.address || "Platz der Republik 1\n11011 Berlin"
  );
  return (name ? name + "\n" : "") + addr;
}

function personalizeText(base, recipient, salutationFallback) {
  const block = recipientToAddressBlock(recipient);
  const sal = (recipient.anrede && /\S/.test(recipient.anrede))
    ? (/,/.test(recipient.anrede) ? recipient.anrede : recipient.anrede + ",")
    : buildPoliteSalutation(recipient.mdb_name || recipient.name || "", salutationFallback || "Sehr geehrte Damen und Herren,");
  return String(base || "")
    .replace("{MdB_Name_und_Adresse}", block)
    .replace("{MdB_Adresse}", block)
    .replace("{Anrede}", sal);
}

/** --- PDF-Erstellung --- */
async function buildLetterPDF({
  queueId, sender, recipient, subject, bodyText, salutation
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

  const pageWidth  = doc.page.width;
  const usableLeft = doc.page.margins.left;
  const usableRight= pageWidth - doc.page.margins.right;
  const usableWidth= usableRight - usableLeft;

  // Header rechts oben
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
  const addrBlock = recipientToAddressBlock(recipient);
  const addressX = usableLeft;
  const addressY = mm(52);
  const addressW = mm(85);
  doc.fontSize(FONT.body).text(addrBlock, addressX, addressY, { width: addressW });

  // Textstart
  const bodyStartY = addressY + doc.heightOfString(addrBlock, { width: addressW }) + mm(10);

  // Betreff
  if (must(subject)) {
    doc.moveDown(0.5);
    doc.font("Times-Bold").fontSize(FONT.body)
       .text(subject, usableLeft, bodyStartY, { width: usableWidth });
    doc.font("Times-Roman");
  }

  // Fließtext – mit Fallback-Anrede
  let cleanBody = stripRecipientParagraph(bodyText || "");
  if (!/^\s*Sehr geehrte[rsn]?/i.test(cleanBody)) {
    const sal = salutation && String(salutation).trim() ? salutation : "Sehr geehrte Damen und Herren,";
    cleanBody = `${sal}\n\n${cleanBody}`;
  }

  const yAfterSubject = must(subject)
    ? bodyStartY + doc.heightOfString(subject, { width: usableWidth }) + mm(2)
    : bodyStartY;

  doc.fontSize(FONT.body).text(cleanBody, usableLeft, yAfterSubject, {
    width: usableWidth,
    align: "left",
    lineGap: 2,
  });

  doc.end();
  return pdfDone;
}

/** --- Statistik: Zähler erhöhen --- */
async function incrementCounter() {
  try {
    const n = await kv.incr("sent_emails");
    await kv.set("sent_emails_last_update", new Date().toISOString());
    return n;
  } catch (e) {
    console.error("KV increment failed:", e);
    return null;
  }
}

/** ——— NEU: ZIP aus Buffern bauen ——— */
async function zipBuffers(files /* [{name, buffer}] */) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const out = [];
  const stream = new PassThrough();
  stream.on("data", (c) => out.push(c));
  const done = new Promise((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(out)));
    archive.on("error", reject);
  });
  archive.pipe(stream);
  for (const f of files) {
    archive.append(f.buffer, { name: f.name });
  }
  await archive.finalize();
  stream.end();
  return done;
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

    // NEU: optional Fan-out
    primary_recipient: raw.primary_recipient || null,
    extra_recipients:  Array.isArray(raw.extra_recipients) ? raw.extra_recipients : [],
  };

  body.sender_zip  = body.sender_zip  || body.zip;
  body.sender_city = body.sender_city || body.city;

  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !must(body[k]));
  if (missing.length) {
    return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
  }

  const nameForSalutation = must(body.mp_name) ? String(body.mp_name).trim() : "";
  const politeSalutation  = nameForSalutation
    ? buildPoliteSalutation(nameForSalutation)
    : "Sehr geehrte Damen und Herren,";

  // Absender
  const sender = {
    name: `${body.first_name} ${body.last_name}`.trim(),
    street: body.street,
    zip: body.sender_zip,
    city: body.sender_city,
  };

  // === Empfänger bestimmen (abwärtskompatibel) ===
  const recipients = [];
  if (body.primary_recipient && typeof body.primary_recipient === "object") {
    recipients.push(body.primary_recipient);
  }
  if (body.extra_recipients.length) {
    for (const r of body.extra_recipients) {
      if (r && typeof r === "object") recipients.push(r);
    }
  }
  if (!recipients.length) {
    // Fallback: wie bisher – ein generischer MdB-Empfänger
    recipients.push({
      mdb_name: body.mp_name || "Mitglied des Deutschen Bundestages",
      bundestag_address: "Platz der Republik 1\n11011 Berlin",
      anrede: politeSalutation,
    });
  }

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // === PDFs generieren (pro Empfänger personalisiert) ===
  const pdfs = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const personalized = personalizeText(body.message, r, politeSalutation);
    const fileName = `Brief_${queueId}_${String(i+1).padStart(2,"0")}_${String(r.mdb_name||r.name||"Empfaenger").replace(/[^\p{L}\p{N}_ -]/gu,"").replace(/\s+/g,"-").slice(0,70)}.pdf`;

    const pdfBuffer = await buildLetterPDF({
      queueId,
      sender,
      recipient: {
        name: r.mdb_name || r.name || "",
        address: r.bundestag_address || r.address || "Platz der Republik 1\n11011 Berlin",
        anrede: r.anrede || "",
        fraktion: r.fraktion || "",
        bundesland: r.bundesland || "",
      },
      subject: body.subject,
      bodyText: personalized,
      salutation: r.anrede || politeSalutation,
    });

    pdfs.push({ name: fileName, buffer: pdfBuffer, meta: r });
  }

  // === Team + Nutzer-HTML ===
  const recipientsListHtml = pdfs.map(p =>
    `- ${esc(p.meta.mdb_name || p.meta.name || "Unbekannt")}${p.meta.fraktion ? " ("+esc(p.meta.fraktion)+")":""}`
  ).join("<br>");

  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
    <p><b>Absender:in</b><br>
      ${esc(sender.name)}<br>
      ${esc(sender.street)}<br>
      ${esc(sender.zip)} ${esc(sender.city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>Empfänger (${pdfs.length}):</b><br>${recipientsListHtml}</p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
  `;

  const userHtml = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <p><b>Empfänger (${pdfs.length}):</b><br>${recipientsListHtml}</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
  `;

  // === Attachments: 1 PDF direkt, >1 als ZIP ===
  let attachments = [];
  if (pdfs.length === 1) {
    attachments = [{ name: pdfs[0].name, content: pdfs[0].buffer.toString("base64") }];
  } else {
    const zipBuffer = await zipBuffers(pdfs);
    attachments = [{ name: `Briefe_${queueId}.zip`, content: zipBuffer.toString("base64") }];
  }

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // 1) TEAM-Mail
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: sender.name },
      subject:`Vorgang ${queueId}: Brief(e) an MdB (${pdfs.length})`,
      htmlContent: teamHtml,
      attachment: attachments
    });

    // Zähler (einmal pro Vorgang)
    await incrementCounter();

    // 2) Optionale Kopie an Absender:in (ohne Attachments oder – wenn gewünscht – nur 1. PDF)
   if (body.copy_to_self) {
  const firstAttachment = pdfs.length
    ? [{ name: pdfs[0].name, content: pdfs[0].buffer.toString("base64") }]
    : [];

  await api.sendTransacEmail({
    to:     [{ email: body.email }],
    sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
    subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
    htmlContent: userHtml,
    attachment: firstAttachment,
  });
}

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, lettersCreated: pdfs.length, copySent: body.copy_to_self });
  } catch (err) {
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});






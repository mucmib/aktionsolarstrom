// /api/queue.js – Serverless Handler (PDF/ZIP + E-Mail via Brevo)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import { kv } from "@vercel/kv";
import archiver from "archiver";
import { PassThrough } from "stream";
import crypto from "crypto";

/* ---------------- CORS ---------------- */
const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

/* --------------- Helpers --------------- */
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

/* --------------- Layout --------------- */
const WINDOW = { left: mm(20), topFromTop: mm(45), width: mm(90), height: mm(45) };
const FONT = { header: 12, body: 11, senderLine: 7.5 };

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
function formatDateDE(d = new Date()) {
  const m = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  return `${d.getDate()}. ${m[d.getMonth()]} ${d.getFullYear()}`;
}
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
function stripLeadingSalutation(txt = "") {
  return String(txt).replace(/^\s*Sehr\s+geehrte[^\n]*\n\s*\n?/i, "");
}
const FEMALE=new Set(["anna","sabine","ursula","katrin","claudia","renate","petra","britta","heike","stefanie","julia","christine","lisa","marie","monika","andrea","martina","sandra","nicole","angelika","eva","kathrin","karin","bettina","svenja","ricarda","elisabeth","maria","linda","sarah"]);
const MALE  =new Set(["hans","peter","wolfgang","thomas","michael","stefan","andreas","markus","martin","frank","jürgen","juergen","klaus","christian","alexander","lars","tobias","sebastian","uwe","ulrich","paul","max","jan","georg","rolf","rainer","christoph","bernd"]);
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

/* --------------- PDF --------------- */
async function buildLetterPDF({ queueId, sender, recipient, subject, bodyText, salutation }) {
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

  // Textstart nach Anschrift
  const bodyStartY = addressY + doc.heightOfString(recipientBlock, { width: addressW }) + mm(10);

  // Betreff
  if (must(subject)) {
    doc.font("Times-Bold").fontSize(FONT.body)
       .text(subject, usableLeft, bodyStartY, { width: usableWidth });
    doc.font("Times-Roman");
  }

  // Fließtext
  let cleanBody = stripRecipientParagraph(bodyText || "");
  cleanBody = stripLeadingSalutation(cleanBody);
  if (!/^\s*Sehr\s+geehrte/i.test(cleanBody)) {
    const sal = salutation && String(salutation).trim() ? salutation : "Sehr geehrte Damen und Herren,";
    cleanBody = `${sal}\n\n${cleanBody}`;
  }
  cleanBody = cleanBody.replace(/\n{3,}/g, "\n\n");

  const yAfterSubject = must(subject)
    ? bodyStartY + doc.heightOfString(subject, { width: usableWidth }) + mm(8)
    : bodyStartY;

  doc.fontSize(FONT.body).text(cleanBody, usableLeft, yAfterSubject, {
    width: usableWidth,
    align: "left",
    lineGap: 3,
  });

  doc.end();
  return pdfDone;
}

/* --------------- ZIP --------------- */
function zipBuffers(files /* [{name, buffer}] */) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (d) => chunks.push(d));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", (err) => reject(err));
    archive.pipe(out);
    files.forEach(f => archive.append(f.buffer, { name: f.name }));
    archive.finalize();
  });
}

/* ------------- Normalize text (dupe) ------------- */
function normalizeText(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* --------------- Email (Brevo) --------------- */
function brevoClient() {
  const api = new Brevo.TransactionalEmailsApi();
  const key = process.env.BREVO_API_KEY || "";
  if (!key) throw new Error("BREVO_API_KEY missing");
  api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, key);
  return api;
}
function toBase64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
}

/* --------------- API Handler --------------- */
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
    last_name:      raw.last_name  ?? raw.nachname ?? "",
    email:          raw.email ?? "",
    street:         raw.street ?? raw.strasse ?? "",
    sender_zip:     raw.sender_zip  ?? raw.plz_abs ?? "",
    sender_city:    raw.sender_city ?? raw.ort_abs ?? "",
    subject:        raw.subject ?? "",
    message:        raw.message ?? "",
    consent_print:  toBool(raw.consent_print ?? raw.postversand ?? false),
    copy_to_self:   toBool(raw.copy_to_self  ?? raw.copy       ?? false),
    primary_recipient: raw.primary_recipient || null,
    extra_recipients: Array.isArray(raw.extra_recipients) ? raw.extra_recipients : [],
  };

  body.sender_zip  = body.sender_zip  || body.zip;
  body.sender_city = body.sender_city || body.city;

  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !must(body[k]));
  if (missing.length) {
    return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
  }

  // Pflicht: Einwilligung zum Postversand
  if (!body.consent_print) {
    return res.status(400).json({ ok:false, error:"CONSENT_REQUIRED", message:"Einwilligung zum Postversand fehlt." });
  }

  // Empfänger sammeln (Primary + Extra, AfD/Werteunion ausfiltern)
  const recipients = [];
  const isExcludedParty = (p="") => /^(afd|werteunion)$/i.test(String(p).trim());
  function pushRecipient(r) {
    if (!r) return;
    const name = (r.mdb_name || r.name || "").trim();
    const addr = (r.bundestag_address || r.address || "").trim() || "Platz der Republik 1\n11011 Berlin";
    const frak = r.fraktion || r.party || "";
    if (isExcludedParty(frak)) return;
    recipients.push({
      name: name || "Mitglied des Deutschen Bundestages",
      address: addr,
      anrede: r.anrede || "",
      fraktion: frak || "",
      bundesland: r.bundesland || "",
    });
  }
  if (body.primary_recipient) pushRecipient(body.primary_recipient);
  (body.extra_recipients || []).forEach(pushRecipient);
  if (recipients.length === 0) {
    pushRecipient({ mdb_name: body.mp_name, bundestag_address: "Platz der Republik 1\n11011 Berlin" });
  }

  // ---- Rate Limits (KV) ----
  try {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
      .split(",")[0].trim().toLowerCase();
    const emailKey = `rl:email:${(body.email || "").toLowerCase()}`;
    const ipKey    = ip ? `rl:ip:${ip}` : null;

    const emailCount = await kv.incr(emailKey);
    if (emailCount === 1) await kv.expire(emailKey, 60 * 60);
    if (emailCount > 3) {
      return res.status(429).json({ ok:false, error:"rate_limited_email", message:"Bitte versuchen Sie es später erneut." });
    }

    if (ipKey) {
      const ipCount = await kv.incr(ipKey);
      if (ipCount === 1) await kv.expire(ipKey, 60 * 60);
      if (ipCount > 10) {
        return res.status(429).json({ ok:false, error:"rate_limited_ip", message:"Bitte versuchen Sie es später erneut." });
      }
    }
  } catch (e) {
    console.warn("KV RL warn:", e?.message || e);
  }

  // Vorgangs-ID & Absender
  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const senderData = {
    name: `${body.first_name} ${body.last_name}`.trim(),
    street: body.street,
    zip: body.sender_zip,
    city: body.sender_city,
  };

  // PDFs erzeugen
  const pdfFiles = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const salForThis = (r.anrede && r.anrede.trim())
      ? r.anrede
      : buildPoliteSalutation(r.name, "Sehr geehrte Damen und Herren,");
    let msgForThis = String(body.message || "");
    msgForThis = stripRecipientParagraph(msgForThis);
    msgForThis = stripLeadingSalutation(msgForThis);
    msgForThis = msgForThis
      .replace(/\{Anrede\}/g, salForThis)
      .replace(/\{Anrede_Name\}/g, r.name || "")
      .replace(/\{Vorname\}/g, body.first_name)
      .replace(/\{Nachname\}/g, body.last_name)
      .replace(/\{Straße\}/g, body.street)
      .replace(/\{PLZ\}/g, body.sender_zip)
      .replace(/\{Ort\}/g, body.sender_city)
      .replace(/\{MdB_Name_und_Adresse\}|\{MdB_Adresse\}/g, `${r.name}\n${r.address}`);

    const pdfBuffer = await buildLetterPDF({
      queueId,
      sender: senderData,
      recipient: { name: r.name, address: r.address },
      subject: body.subject,
      bodyText: msgForThis,
      salutation: salForThis,
    });

    const filename = recipients.length === 1
      ? `Brief_${queueId}.pdf`
      : `Brief_${queueId}_${String(i+1).padStart(2,"0")}.pdf`;

    pdfFiles.push({ name: filename, buffer: pdfBuffer });
  }

  // Anhang vorbereiten
  let attachmentName, attachmentBuffer;
  if (pdfFiles.length === 1) {
    attachmentName   = pdfFiles[0].name;
    attachmentBuffer = pdfFiles[0].buffer;
  } else {
    attachmentName   = `Briefe_${queueId}.zip`;
    attachmentBuffer = await zipBuffers(pdfFiles);
  }
  const attachment = { name: attachmentName, content: toBase64(attachmentBuffer) };

  // Mails senden
  const api = brevoClient();
  const FROM_EMAIL = process.env.SENDER_EMAIL || "noreply@example.com";
  const FROM_NAME  = process.env.SENDER_NAME  || "Kampagne";
  const TEAM_EMAIL = process.env.TEAM_EMAIL   || "";

  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Absender:in</b><br>
      ${esc(body.first_name)} ${esc(body.last_name)}<br>
      ${esc(body.street)}<br>
      ${esc(body.sender_zip)} ${esc(body.sender_city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>Empfänger (${recipients.length}):</b><br>
      ${recipients.map(r => esc(r.name + (r.fraktion ? ` – ${r.fraktion}` : ""))).join("<br>")}
    </p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
  `;
  const userHtml = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <p>Sie erhalten diesen Brief im Anhang als Kopie.</p>
  `;

  try {
    // 1) Team-Mail (immer)
    if (TEAM_EMAIL) {
      await api.sendTransacEmail({
        sender: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: TEAM_EMAIL }],
        subject: `Neue Einreichung ${queueId} (${recipients.length} Empf.)`,
        htmlContent: teamHtml,
        attachment: [{ name: attachment.name, content: attachment.content }],
      });
    }

    // 2) Nutzer-Mail (optional, wenn Kopie gewünscht)
    if (body.copy_to_self && must(body.email)) {
      await api.sendTransacEmail({
        sender: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: body.email, name: senderData.name }],
        subject: `Ihre Brief-Einreichung – Vorgangs-ID ${queueId}`,
        htmlContent: userHtml,
        attachment: [{ name: attachment.name, content: attachment.content }],
      });
    }
  } catch (e) {
    console.error("Brevo send error:", e?.message || e);
    return res.status(502).json({ ok:false, error:"email_send_failed", message:"E-Mail-Versand fehlgeschlagen." });
  }

  // Erfolg
  res.status(200).json({
    ok: true,
    queueId,
    files: pdfFiles.map(f => f.name),
    zipped: pdfFiles.length > 1 ? attachment.name : null
  });
});














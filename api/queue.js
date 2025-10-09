// /api/queue.js – Vercel Serverless Function (Fan-out + ZIP, pro-Empfänger-Anrede, ZIP an User bei >1 PDF)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import { kv } from "@vercel/kv";
import archiver from "archiver";
import { PassThrough } from "stream";

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

/** Bundestag-Adresse robust normalisieren */
function normalizeBtAddress(addr = "Platz der Republik 1\n11011 Berlin") {
  const lines = String(addr).split("\n").map(s => s.trim()).filter(Boolean);
  const hasHeader = lines.some(l => /^deutscher\s+bundestag$/i.test(l));
  return (hasHeader ? lines : ["Deutscher Bundestag", ...lines]).join("\n");
}

/** --- Layout-Konstanten --- */
const WINDOW = { left: mm(20), topFromTop: mm(45), width: mm(90), height: mm(45) };

/** Schriftgrößen zentral */
const FONT = {
  header: 12,
  body: 11,
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
  const addrLines = [];
  if (recipient.name) addrLines.push(recipient.name);
  const addr = normalizeBtAddress(recipient.address || "Platz der Republik 1\n11011 Berlin");
  addr.split("\n").forEach(l => addrLines.push(l));
  const recipientBlock = addrLines.join("\n");

  const addressX = usableLeft;
  const addressY = mm(52);
  const addressW = mm(85);
  doc.fontSize(FONT.body).text(recipientBlock, addressX, addressY, { width: addressW });

  // Textstart nach Anschrift
  const bodyStartY = addressY + doc.heightOfString(recipientBlock, { width: addressW }) + mm(10);

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

/** ZIP aus Buffern erstellen */
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

/** --- Statistik-Zähler --- */
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

    // Neu (vom Frontend):
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

  // Empfängerliste bauen (primary zuerst, dann extra – AFD/Werteunion filtern)
  const recipients = [];
  const isExcludedParty = (p="") => /^(afd|werteunion)$/i.test(String(p).trim());

  function pushRecipient(r) {
    if (!r) return;
    const name = (r.mdb_name || r.name || "").trim();
    const addr = normalizeBtAddress((r.bundestag_address || r.address || "").trim() || "Platz der Republik 1\n11011 Berlin");
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

  // IDs & Datum
  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // Absender-Platzhalter einmalig ersetzen (KEINE Anrede/Adresse hier!)
  let baseMessage = body.message;
  baseMessage = baseMessage.split("{Vorname}").join(body.first_name);
  baseMessage = baseMessage.split("{Nachname}").join(body.last_name);
  baseMessage = baseMessage.split("{Straße}").join(body.street);
  baseMessage = baseMessage.split("{PLZ}").join(body.sender_zip);
  baseMessage = baseMessage.split("{Ort}").join(body.sender_city);

  const senderData = {
    name: `${body.first_name} ${body.last_name}`.trim(),
    street: body.street,
    zip: body.sender_zip,
    city: body.sender_city,
  };

  // PDFs erzeugen (pro Empfänger Anrede & Adresse einsetzen)
  const pdfFiles = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];

    const salForThis = r.anrede && r.anrede.trim()
      ? (/,\s*$/.test(r.anrede) ? r.anrede : r.anrede + ",")
      : buildPoliteSalutation(r.name);

    let msgForThis = baseMessage;
    msgForThis = msgForThis.split("{Anrede}").join(salForThis);
    msgForThis = msgForThis.split("{Anrede_Name}").join(r.name || "");
    const nameAddr = (r.name ? r.name + "\n" : "") + r.address;
    msgForThis = msgForThis.split("{MdB_Name_und_Adresse}").join(nameAddr);
    msgForThis = msgForThis.split("{MdB_Adresse}").join(r.address);

    const pdfBuffer = await buildLetterPDF({
      queueId: recipients.length === 1 ? queueId : `${queueId}-${String(i + 1).padStart(2, "0")}`,
      sender: senderData,
      recipient: { name: r.name, address: r.address },
      subject: body.subject,
      bodyText: msgForThis,
      salutation: salForThis,
    });

    const safeName = String(r.name || "Empfaenger")
      .replace(/[^\wäöüÄÖÜß-]+/g, "_")
      .slice(0, 60);
    const filename = recipients.length === 1
      ? `Brief_${queueId}.pdf`
      : `Brief_${queueId}_${String(i+1).padStart(2,"0")}_${safeName}.pdf`;

    pdfFiles.push({ name: filename, buffer: pdfBuffer });
  }

  // Mail-HTMLs
  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
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

  const userHtmlSingle = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <p>Im Anhang finden Sie die PDF-Version Ihres Briefes.</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
  `;

  const userHtmlZip = `
    <p>Danke – wir haben Ihre Briefe übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <p>Im Anhang finden Sie ein ZIP mit allen PDFs.</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // TEAM: 1 PDF oder ZIP
    let teamAttachments = [];
    let zipBufForUser = null;
    if (pdfFiles.length === 1) {
      teamAttachments = [{ name: pdfFiles[0].name, content: pdfFiles[0].buffer.toString("base64") }];
    } else {
      const zipBuf = await zipBuffers(pdfFiles);
      zipBufForUser = zipBuf; // später für User nutzen
      teamAttachments = [{ name: `Briefe_${queueId}.zip`, content: zipBuf.toString("base64") }];
    }

    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief(e) an MdB`,
      htmlContent: teamHtml,
      attachment: teamAttachments
    });

    // Zähler
    await incrementCounter();

    // USER: je nach Anzahl PDFs – bei >1 bekommt der/die Absender:in die ZIP
    if (body.copy_to_self && pdfFiles.length > 0) {
      const userAttachments =
        pdfFiles.length === 1
          ? [{ name: pdfFiles[0].name, content: pdfFiles[0].buffer.toString("base64") }]
          : [{ name: `Briefe_${queueId}.zip`, content: (zipBufForUser || await zipBuffers(pdfFiles)).toString("base64") }];

      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: pdfFiles.length === 1 ? userHtmlSingle : userHtmlZip,
        attachment: userAttachments
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, recipients: recipients.length, copySent: !!body.copy_to_self });
  } catch (err) {
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed:", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed", status, detail });
  }
});





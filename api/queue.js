// /api/queue.js – Vercel Serverless Function (Fan-out + ZIP + Dedupe/RL)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import { kv } from "@vercel/kv";
import archiver from "archiver";
import { PassThrough } from "stream";
import crypto from "crypto";

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
const FONT = { header: 12, body: 11, senderLine: 7.5 };

/** >>> ADD: Nur verkleinern – keine Kürzung. Sucht die größte Schriftgröße ≤ base, die in die Höhe passt. */
function bestFontSizeToFit(doc, text, width, maxHeight, baseSize = 11, minSize = 9, lineGap = 2) {
  for (let s = baseSize; s >= minSize; s -= 0.5) {
    doc.fontSize(s);
    const h = doc.heightOfString(text, { width, lineGap });
    if (h <= maxHeight) return s;
  }
  return minSize; // notfalls kleinste Größe; wenn es dann noch nicht passt, darf es auf Seite 2 laufen
}

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

/** Adresse/Anrede evtl. aus Nutzertext entfernen (doppelt vermeiden) */
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

/** Anrede-Helfer */
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

/** --- PDF-Erstellung --- */
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

  // Betreff (ohne moveDown; absolut positioniert)
  if (must(subject)) {
    doc.font("Times-Bold").fontSize(FONT.body)
       .text(subject, usableLeft, bodyStartY, { width: usableWidth });
    doc.font("Times-Roman");
  }

  // Fließtext – Anrede sauber behandeln
  let cleanBody = stripRecipientParagraph(bodyText || "");
  cleanBody = stripLeadingSalutation(cleanBody);
  if (!/^\s*Sehr\s+geehrte/i.test(cleanBody)) {
    const sal = salutation && String(salutation).trim() ? salutation : "Sehr geehrte Damen und Herren,";
    cleanBody = `${sal}\n\n${cleanBody}`;
  }
  cleanBody = cleanBody.replace(/\n{3,}/g, "\n\n");

  // Abstand zwischen Betreff und Body
  const yAfterSubject = must(subject)
    ? bodyStartY + doc.heightOfString(subject, { width: usableWidth }) + mm(8)
    : bodyStartY;

  // >>> ADD: Nur verkleinern, nie kürzen – bestmögliche Schriftgröße ermitteln
  const availableHeight = (doc.page.height - doc.page.margins.bottom) - yAfterSubject;
  const chosenSize = bestFontSizeToFit(doc, cleanBody, usableWidth, availableHeight, FONT.body, 9, 2);
  doc.fontSize(chosenSize).text(cleanBody, usableLeft, yAfterSubject, {
    width: usableWidth,
    align: "left",
    lineGap: 2
  });
  // <<< END ADD

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

/** ---- Deduping / Rate-Limits Helfer ---- */
function normalizeText(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function recipientsSignature(list = []) {
  const items = (Array.isArray(list) ? list : [])
    .map(r => `${(r.mdb_name || r.name || "").trim()}|${(r.bundestag_address || r.address || "").trim()}`)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
  return items.join(";");
}
function buildFingerprint({ email, subject, message, recipients }) {
  const payload = JSON.stringify({
    email: normalizeText(email || ""),
    subject: normalizeText(subject || ""),
    message: normalizeText(String(message || "")
      .replace(/\{Vorname\}|\{Nachname\}|\{Straße\}|\{PLZ\}|\{Ort\}/g, "")
      .replace(/\{MdB_Name_und_Adresse\}|\{MdB_Adresse\}/g, "")
    ),
    recipients: recipientsSignature(recipients),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** >>> pureSwitch: eigener Handler-Zweig, KEIN Einfluss auf Briefformulare */
async function handlePureSwitch(raw, res) {
  const data = {
    role:       raw.role || "",
    first_name: raw.first_name || raw.vorname || "",
    last_name:  raw.last_name  || raw.nachname || "",
    email:      raw.email || "",
    phone:      raw.phone || "",
    zip:        raw.zip || raw.plz || "",
    city:       raw.city || raw.ort || "",
    message:    raw.message || "",
    subject:    raw.subject || "Neue pureSwitch-Anfrage über aktionsolarstrom.de",
    source:     raw.source || "pureswitch-kontakt",
  };

  const missing = ["role","first_name","last_name","email","zip","city","message"]
    .filter((k) => !must(data[k]));
  if (missing.length) {
    return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
  }

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    const html = `
      <h2>Neue pureSwitch-Anfrage</h2>
      <p><b>Rolle:</b> ${esc(data.role)}</p>
      <p><b>Name:</b> ${esc(data.first_name)} ${esc(data.last_name)}</p>
      <p><b>E-Mail:</b> ${esc(data.email)}<br>
         <b>Telefon:</b> ${esc(data.phone || "–")}</p>
      <p><b>PLZ / Ort:</b> ${esc(data.zip)} ${esc(data.city)}</p>
      <p><b>Nachricht:</b><br>${esc(data.message).replace(/\n/g,"<br>")}</p>
      <p><b>Quelle:</b> ${esc(data.source)}</p>
    `;

    await api.sendTransacEmail({
      to: [
        {
          email: process.env.PURESWITCH_INBOX || process.env.TEAM_INBOX,
          name: "pureSwitch-Anfragen"
        }
      ],
      sender: {
        email: process.env.FROM_EMAIL,
        name: "Aktionsolarstrom – pureSwitch Formular"
      },
      replyTo: {
        email: data.email,
        name: `${data.first_name} ${data.last_name}`
      },
      subject: data.subject,
      htmlContent: html
    });

    // Optional: Kontakt in Brevo-Liste "pureSwitch-Anfragen" eintragen
    const listIdRaw = process.env.BREVO_PURESWITCH_LIST_ID;
    const listId = listIdRaw ? Number(listIdRaw) : 0;
    if (listId && !Number.isNaN(listId)) {
      try {
        const contactsApi = new Brevo.ContactsApi();
        contactsApi.setApiKey(Brevo.ContactsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

        await contactsApi.createContact({
          email: data.email,
          listIds: [listId],
          attributes: {
            FIRSTNAME: data.first_name,
            LASTNAME:  data.last_name,
            ROLE:      data.role,
            ZIP:       data.zip,
            CITY:      data.city,
            SOURCE:    "pureSwitch"
          },
          updateEnabled: true
        });
      } catch (e) {
        console.error("Brevo contact create failed (pureSwitch, non-blocking):", e?.message || e);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, type:"pureswitch", message:"stored_and_mailed" });
  } catch (err) {
    const status = err?.response?.status;
    let detail   = err?.response?.text || err?.message || String(err);
    if (err?.response?.body) { try { detail = JSON.stringify(err.response.body); } catch {} }
    console.error("Brevo send failed (pureSwitch):", status, detail);
    return res.status(502).json({ ok:false, error:"brevo_send_failed_pureswitch", status, detail });
  }
}
/** <<< pureSwitch Ende */

/** --- Handler --- */
export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  const raw = readBody(req);

  // >>> pureSwitch-Branch: wenn von deiner neuen Unterseite, dann hier raus
  if (raw.source === "pureswitch-kontakt") {
    return await handlePureSwitch(raw, res);
  }
  // <<< alle anderen Anfragen laufen weiter wie bisher (Briefformular)

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

  // Empfängerliste
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

  // ---------- Dedupe + Rate Limits ----------
  try {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
      .split(",")[0].trim().toLowerCase();
    const emailKey = `rl:email:${(body.email || "").toLowerCase()}`;
    const ipKey    = ip ? `rl:ip:${ip}` : null;

    // 1) pro E-Mail max. 3 Vorgänge / 60 Min
    const emailCount = await kv.incr(emailKey);
    if (emailCount === 1) await kv.expire(emailKey, 60 * 60);
    if (emailCount > 3) {
      console.warn("Dupe/RL", { email: body.email, ip, reason: "rate_limited_email" });
      return res.status(429).json({ ok:false, error:"rate_limited_email", retry_after_seconds: 3600 });
    }

    // 2) optional: pro IP max. 10 Vorgänge / 60 Min
    if (ipKey) {
      const ipCount = await kv.incr(ipKey);
      if (ipCount === 1) await kv.expire(ipKey, 60 * 60);
      if (ipCount > 10) {
        console.warn("Dupe/RL", { email: body.email, ip, reason: "rate_limited_ip" });
        return res.status(429).json({ ok:false, error:"rate_limited_ip", retry_after_seconds: 3600 });
      }
    }

    // 3) Fingerprint (10 Min dedupe)
    const fingerprint = buildFingerprint({
      email: body.email,
      subject: body.subject,
      message: body.message,
      recipients,
    });
    const dupeKey = `dupe:${fingerprint}`;
    const created = await kv.set(dupeKey, "1", { nx: true, ex: 10 * 60 });
    if (!created) {
      console.warn("Dupe/RL", { email: body.email, ip, reason: "duplicate_recent" });
      return res.status(429).json({ ok:false, error:"duplicate_recent", retry_after_seconds: 600 });
    }
  } catch (e) {
    // Wenn KV ausfällt, nicht blockieren – einfach weiter
    console.error("KV dedupe/rl failed (non-blocking):", e?.message || e);
  }
  // ---------- Ende Dedupe + Rate Limits ----------

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

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
    // (keine Kürzung mehr; nur Verkleinern passiert in buildLetterPDF)

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

  // Mails
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

  const userHtml = `
    <p>Danke – wir haben Ihren Brief übernommen und bereiten den Postversand vor.</p>
    <p><b>Vorgangs-ID:</b> ${esc(queueId)}</p>
    <hr>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p>Im Anhang finden Sie die PDF-Version Ihres Briefes (erste Empfänger:in).</p>
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    // TEAM: 1 PDF oder ZIP
    let teamAttachments = [];
    if (pdfFiles.length === 1) {
      teamAttachments = [{ name: pdfFiles[0].name, content: pdfFiles[0].buffer.toString("base64") }];
    } else {
      const zipBuf = await zipBuffers(pdfFiles);
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

    // Statistik nur nach erfolgreicher TEAM-Mail
    try {
      const added = recipients.length;
      await kv.incrby("pdfs_generated", added);
      const nowISO = new Date().toISOString();
      await kv.set("stats_updated_at", nowISO);
      await kv.set("last_update", nowISO);
    } catch (e) {
      console.error("KV stats failed (non-blocking):", e?.message || e);
    }

    // Optionale Kopie an Absender:in
    if (body.copy_to_self && pdfFiles.length > 0) {
      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml,
        attachment: [{ name: pdfFiles[0].name, content: pdfFiles[0].buffer.toString("base64") }]
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


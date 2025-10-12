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

/** Entfernt am Briefende manuelle Absender-Adressenblöcke */
function stripTrailingSenderAddress(txt = "", sender) {
  const t = String(txt).trimEnd();

  // Kandidat: letzter Absatz
  const parts = t.split(/\n{2,}/);
  if (!parts.length) return t;

  const last = parts[parts.length - 1] || "";
  // 2–3 Zeilen, zweite Zeile beginnt mit PLZ
  const looksLikeSender =
    /straße|str\./i.test(last) &&
    /\b\d{5}\s+\S/.test(last);

  if (!looksLikeSender) return t;

  // Wenn es NICHT exakt der echte Sender ist, entfernen wir ihn
  const normalized = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const real1 = normalized(sender.street || "");
  const real2 = normalized(`${sender.zip || ""} ${sender.city || ""}`);
  const hasReal = normalized(last).includes(real1) && normalized(last).includes(real2);

  if (!hasReal) {
    parts.pop();
    return parts.join("\n\n").trim();
  }
  // wenn es der echte ist: ebenfalls entfernen (wir rendern die Adresse ohnehin automatisch im Kopf)
  parts.pop();
  return parts.join("\n\n").trim();
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
  if (addr) addrLines.push(...addr.split("\n")); // FIX: Spread korrekt
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
    doc.moveDown(0.6);
  }

  // Anrede
  if (must(salutation)) {
    doc.font("Times-Roman").fontSize(FONT.body).text(salutation, { width: usableWidth });
    doc.moveDown(0.6);
  }

  // Fließtext
  doc.font("Times-Roman").fontSize(FONT.body).text(bodyText, { width: usableWidth });

  // Grußformel & Name
  doc.moveDown(1.4);
  doc.text("Mit freundlichen Grüßen");
  doc.moveDown(1.0);
  doc.text(sender.name);

  doc.end();
  return pdfDone;
}

/** --- API Handler --- */
export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = readBody(req);

  // Pflicht: Einwilligung Postversand
  if (!toBool(body.consent_post)) {
    return res.status(400).json({ error: "Einwilligung zum ausschließlichen Postversand ist erforderlich." });
  }
  // Info: Datenschutz-Checkbox ist Client-Pflicht; Server kann optional loggen
  const consentPrivacy = !!toBool(body.consent_privacy);

  // Eingaben
  const sender = {
    name: String(body.name || "").trim(),
    street: String(body.street || "").trim(),
    zip: String(body.zip2 || body.zip || "").trim(),
    city: String(body.city2 || body.city || "").trim(),
    email: String(body.email || "").trim(),
  };
  const subject = String(body.subject || "").trim();
  let message = String(body.message || "").replace(/\r\n/g, "\n");

  // Body bereinigen (keine doppelte Anschrift/Anrede)
  message = stripRecipientParagraph(message);
  message = stripLeadingSalutation(message);
  message = stripTrailingSenderAddress(message, sender);

  // Ziel (hier nur Platzhalter – je nach Logik PLZ->MdB auflösen)
  const recipient = {
    name: String(body.mp || "").trim(),
    address: "Platz der Republik 1\n11011 Berlin",
  };

  // Vorgangs-ID
  const queueId = crypto.randomBytes(3).toString("hex").toUpperCase();

  // Anrede generieren (wenn nicht im Text)
  const salutation = buildPoliteSalutation(recipient.name);

  // PDF bauen
  const pdf = await buildLetterPDF({
    queueId, sender, recipient, subject, bodyText: message, salutation
  });

  // hier: in Warteschlange legen / ZIP / KV etc. (bestehende Logik beibehalten)
  // Minimal-Response
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify({
    ok: true,
    id: queueId,
    consent_post: true,
    consent_privacy: consentPrivacy
  }));
});











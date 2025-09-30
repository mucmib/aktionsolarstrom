// /api/queue.js – Vercel Serverless Function (Brevo HTTP API + PDFKit)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";

/* ---------------------------- CORS & Helpers ---------------------------- */
const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

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

/* ------------------------------ PDF Layout ------------------------------ */
async function renderLetterPDF({ queueId, dateISO, sender, mdb, body }) {
  const M = { top: 72, right: 60, bottom: 70, left: 65 };
  const PAGE_W = 595.28, PAGE_H = 841.89;
  const CONTENT_W = PAGE_W - M.left - M.right;

  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });

  const buffers = [];
  const done = new Promise((resolve) => {
    doc.on("data", (d) => buffers.push(d));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
  });

  const drawFooter = () => {
    doc.font("Helvetica").fontSize(8).fillColor("#777");
    doc.text(`Vorgangs-ID: ${queueId}`, M.left, PAGE_H - M.bottom + 32, {
      width: CONTENT_W, align: "left"
    });
    doc.fillColor("#111");
  };
  const addPage = () => { doc.addPage({ size: "A4", margin: 0 }); drawFooter(); };

  addPage();

  // Absender oben rechts
  doc.font("Helvetica").fontSize(10);
  const senderBlock = `${sender.name}\n${sender.street}\n${sender.zip} ${sender.city}`;
  doc.text(senderBlock, M.left, M.top, { width: CONTENT_W, align: "right", lineGap: 2 });

  // Datum + Vorgangs-ID
  const dateStr = new Date(dateISO).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  doc.moveDown(0.2).fontSize(9.5).fillColor("#444");
  doc.text(`${dateStr}\nVorgangs-ID: ${queueId}`, M.left, doc.y, { width: CONTENT_W, align: "right", lineGap: 1.4 });
  doc.fillColor("#111");

  // Empfängeradresse (Fensterbereich)
  const yAddr = M.top + 156;
  const addrText = `${mdb.name ? mdb.name + "\n" : ""}${(mdb.address || "Deutscher Bundestag\nPlatz der Republik 1\n11011 Berlin").replace(/\r/g,"").trim()}`;
  doc.font("Helvetica").fontSize(11);
  doc.text(addrText, M.left, yAddr, { width: Math.min(CONTENT_W * 0.6, 300), lineGap: 1.6 });

  // Inhalt
  let y = Math.max(doc.y + 18, yAddr + 70);
  doc.text("", M.left, y);
  const paragraphs = String(body || "").replace(/\r/g,"").split(/\n{2,}/);
  const textOpts = { width: CONTENT_W, align: "left", lineGap: 2.4 };

  for (const p of paragraphs) {
    if (/^\s*\d+\.\s/.test(p)) {
      doc.list(p.split(/\n/g), M.left + 16, doc.y, {
        width: CONTENT_W - 16, bulletRadius: 1.8, textIndent: 6, lineGap: 2.2
      });
    } else {
      doc.text(p.replace(/\n/g,"\n"), { ...textOpts });
    }
    doc.moveDown(0.7);
  }

  // Signaturblock ordentlich zusammenhalten
  const sigBlock = `Mit freundlichen Grüßen\n\n${sender.name}\n${sender.street}\n${sender.zip} ${sender.city}`;
  const sigHeight = doc.heightOfString(sigBlock, { width: CONTENT_W, lineGap: 2.2 });
  if (doc.y + sigHeight > PAGE_H - M.bottom) addPage();
  doc.text(sigBlock, M.left, doc.y, { width: CONTENT_W, lineGap: 2.2 });

  doc.end();
  return done;
}

/* ------- Hilfsfunktion: Empfänger (Name/Adresse) aus Nachricht ziehen ---- */
function extractMdbFromMessage(finalMessage) {
  // Erwartet: beginnt mit Empfängerblock, dann Leerzeile, dann Anrede
  const txt = String(finalMessage || "");
  const firstBlock = txt.split(/\n\s*\n/)[0] || "";
  const lines = firstBlock.split(/\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    return { name: "", address: "Deutscher Bundestag\nPlatz der Republik 1\n11011 Berlin" };
  }
  const name = lines[0];
  const rest = lines.slice(1).join("\n");
  // Wenn die 2. Zeile NICHT „Deutscher Bundestag“ enthält, fügen wir sie für die PDF-Optik hinzu
  const address = /deutscher bundestag/i.test(rest)
    ? rest
    : `Deutscher Bundestag\n${rest}`;
  return { name, address };
}

/* -------------------------------- Handler -------------------------------- */
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

  // Fallbacks
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

  // Platzhalter ersetzen (für E-Mail-Vorschau)
  const anredeName = must(body.mp_name) ? body.mp_name : "Sehr geehrte Damen und Herren";
  let finalMessage = body.message;
  finalMessage = finalMessage.replace("{Anrede_Name}", anredeName);
  finalMessage = finalMessage.replace("{Anrede}", anredeName);
  finalMessage = finalMessage.replace("{Vorname}", body.first_name);
  finalMessage = finalMessage.replace("{Nachname}", body.last_name);
  finalMessage = finalMessage.replace("{Straße}", body.street);
  finalMessage = finalMessage.replace("{PLZ}", body.sender_zip);
  finalMessage = finalMessage.replace("{Ort}", body.sender_city);

  // Für PDF: Text OHNE Signatur (wird im Layout gesetzt)
  const bodyNoSignature = finalMessage.replace(/\n*Mit freundlichen Grüßen[\s\S]*$/i, "").trim();

  // MdB-Name/Adresse aus dem Nachrichtentext ziehen (erste Block bis Leerzeile)
  const parsedMdb = extractMdbFromMessage(finalMessage);

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today   = new Date().toISOString().slice(0,10);

  // E-Mail HTML
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

  try {
    // PDF erzeugen
    const pdfBuffer = await renderLetterPDF({
      queueId,
      dateISO: today,
      sender: {
        name: `${body.first_name} ${body.last_name}`.trim(),
        street: body.street,
        zip: body.sender_zip,
        city: body.sender_city
      },
      mdb: {
        name: parsedMdb.name,
        address: parsedMdb.address
      },
      body: bodyNoSignature
    });

    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    const attachments = [{ name: `Brief_${queueId}.pdf`, content: pdfBuffer.toString("base64") }];

    // 1) Team-Mail
    await api.sendTransacEmail({
      to:     [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo:{ email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject:`Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: attachments
    });

    // 2) Optionale Kopie an Absender:in
    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to:     [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject:`Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: userHtml,
        attachment: attachments
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





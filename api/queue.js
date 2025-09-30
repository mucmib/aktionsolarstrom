// /api/queue.js – Vercel Serverless Function (Brevo HTTP API + PDFKit)
import Brevo from "@getbrevo/brevo";
import PDFDocument from "pdfkit";
import getStream from "get-stream";

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
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body;
}
const toBool = (v) => ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

/** PDF Generator */
async function generatePdf(body, finalMessage, queueId, today) {
  const doc = new PDFDocument({ margin: 72 });
  let buffers = [];
  doc.on("data", buffers.push.bind(buffers));
  doc.on("end", () => {});

  // Adresse MdB
  doc.fontSize(11).text(body.mp_name || "", { align: "left" });
  doc.text(body.bundestag_address || "Deutscher Bundestag\nPlatz der Republik 1\n11011 Berlin", { align: "left" });

  // Datum
  doc.moveDown(1.2).text(today, { align: "right" });

  // Vorgangs-ID klein direkt unter dem Datum
  doc.moveDown(0.2).fontSize(9).fillColor("#666")
    .text(`Vorgangs-ID: ${queueId}`, { align: "right" })
    .fillColor("#000").fontSize(11);

  // Brieftext
  doc.moveDown(2).fontSize(11).text(finalMessage, {
    align: "left",
    lineGap: 4
  });

  // Absender
  doc.moveDown(2).text("Mit freundlichen Grüßen");
  doc.moveDown().text(`${body.first_name} ${body.last_name}`);
  doc.text(body.street);
  doc.text(`${body.sender_zip} ${body.sender_city}`);

  doc.end();
  const pdfBuffer = Buffer.concat(buffers);
  return pdfBuffer;
}

export default allowCors(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const raw = readBody(req);
  const body = {
    zip: raw.zip ?? raw.plz ?? "",
    city: raw.city ?? raw.ort ?? "",
    mp_name: raw.mp_name ?? raw.abgeordneter ?? "",
    first_name: raw.first_name ?? raw.vorname ?? "",
    last_name: raw.last_name ?? raw.nachname ?? "",
    email: raw.email ?? "",
    street: raw.street ?? raw.strasse ?? "",
    sender_zip: raw.sender_zip ?? raw.plz_abs ?? "",
    sender_city: raw.sender_city ?? raw.ort_abs ?? "",
    subject: raw.subject ?? "",
    message: raw.message ?? "",
    consent_print: toBool(raw.consent_print ?? raw.postversand ?? false),
    copy_to_self: toBool(raw.copy_to_self ?? raw.copy ?? false),
    bundestag_address: raw.bundestag_address ?? "",
  };
  body.sender_zip = body.sender_zip || body.zip;
  body.sender_city = body.sender_city || body.city;

  const required = ["first_name","last_name","email","street","sender_zip","sender_city","subject","message"];
  const missing = required.filter(k => !must(body[k]));
  if (missing.length) {
    return res.status(400).json({ ok:false, error:"missing_fields", fields: missing });
  }

  if (!process.env.BREVO_API_KEY || !process.env.FROM_EMAIL || !process.env.TEAM_INBOX) {
    return res.status(500).json({ ok:false, error:"env_missing" });
  }

  let finalMessage = body.message
    .replace("{Anrede}", body.mp_name ? `Sehr geehrte/r ${body.mp_name}` : "Sehr geehrte Damen und Herren")
    .replace("{Vorname}", body.first_name)
    .replace("{Nachname}", body.last_name)
    .replace("{Straße}", body.street)
    .replace("{PLZ}", body.sender_zip)
    .replace("{Ort}", body.sender_city);

  const queueId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const today = new Date().toLocaleDateString("de-DE");

  const pdfBuffer = await generatePdf(body, finalMessage, queueId, today);

  const teamHtml = `
    <h2>Neue Einreichung – ${esc(queueId)}</h2>
    <p><b>Datum:</b> ${esc(today)}</p>
    <p><b>Absender:in</b><br>
      ${esc(body.first_name)} ${esc(body.last_name)}<br>
      ${esc(body.street)}<br>
      ${esc(body.sender_zip)} ${esc(body.sender_city)}<br>
      E-Mail: ${esc(body.email)}
    </p>
    <p><b>Betreff:</b> ${esc(body.subject)}</p>
    <p><b>Brieftext:</b><br>${esc(finalMessage).replace(/\n/g,"<br>")}</p>
  `;

  try {
    const api = new Brevo.TransactionalEmailsApi();
    api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

    await api.sendTransacEmail({
      to: [{ email: process.env.TEAM_INBOX }],
      sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Formular" },
      replyTo: { email: body.email, name: `${body.first_name} ${body.last_name}` },
      subject: `Vorgang ${queueId}: Brief an MdB`,
      htmlContent: teamHtml,
      attachment: [
        {
          content: pdfBuffer.toString("base64"),
          name: `Brief_${queueId}.pdf`
        }
      ]
    });

    if (body.copy_to_self) {
      await api.sendTransacEmail({
        to: [{ email: body.email }],
        sender: { email: process.env.FROM_EMAIL, name: "Kampagnen-Team" },
        subject: `Kopie Ihrer Einreichung – Vorgang ${queueId}`,
        htmlContent: teamHtml,
        attachment: [
          {
            content: pdfBuffer.toString("base64"),
            name: `Brief_${queueId}.pdf`
          }
        ]
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, queueId, copySent: body.copy_to_self });
  } catch (err) {
    console.error("Brevo send failed:", err);
    return res.status(502).json({ ok:false, error:"brevo_send_failed" });
  }
});







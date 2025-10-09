// /api/stats.js – gibt aggregierte Zähler zurück (u.a. erzeugte PDFs)
import { kv } from "@vercel/kv";

const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  return await fn(req, res);
};

export default allowCors(async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  // Keys wie zuvor in queue.js verwendet
  async function getNum(key) {
    try {
      const v = await kv.get(key);
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  const [emails, pdfs, zips, recipients, updatedAt] = await Promise.all([
    getNum("emails_sent"),
    getNum("pdfs_generated"),
    getNum("zips_generated"),
    getNum("recipients_total"),
    kv.get("stats_last_update").catch(() => null),
  ]);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    emails_sent: emails,
    pdfs_generated: pdfs,
    zips_generated: zips,
    recipients_total: recipients,
    updated_at: updatedAt || null,
  });
});

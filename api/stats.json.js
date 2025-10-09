// /api/stats.js – liefert aktuelle Statistik (PDFs, Datum etc.)
import { kv } from "@vercel/kv";

/**
 * Diese API-Route wird von der Startseite abgefragt:
 * fetch('/api/stats.json')
 * Sie gibt ein JSON mit Zählerständen zurück.
 */
export default async function handler(req, res) {
  // CORS für Sicherheit und lokale Tests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    // Hauptzähler (Anzahl erzeugter PDFs)
    const pdfs_generated = Number(await kv.get("pdfs_generated")) || 0;

    // optional: alte Kompatibilität
    const sent_emails = Number(await kv.get("sent_emails")) || 0;
    const count = pdfs_generated || sent_emails;

    // Zeitpunkt der letzten Aktualisierung
    const last_update =
      (await kv.get("stats_updated_at")) ||
      (await kv.get("sent_emails_last_update")) ||
      new Date().toISOString();

    // Optional: weitere Werte, falls du sie später ergänzt
    const zips_generated = Number(await kv.get("zips_generated")) || 0;
    const recipients_total = Number(await kv.get("recipients_total")) || 0;

    return res.status(200).json({
      ok: true,
      pdfs_generated: count,
      sent_emails,
      zips_generated,
      recipients_total,
      last_update,
    });
  } catch (err) {
    console.error("Fehler beim Lesen aus KV:", err);
    return res.status(500).json({
      ok: false,
      error: "kv_read_failed",
      message: String(err),
    });
  }
}

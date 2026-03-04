// /api/global.js
import { kv } from "@vercel/kv";

function todayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`; // UTC-Tag
}

export default async function handler(req, res) {
  try {
    const day = todayKey();

    const [
      total_cents,
      total_count,
      today_cents,
      today_count,
      updated_at,
    ] = await Promise.all([
      kv.get("global_total_raised_cents"),
      kv.get("global_total_donations_count"),
      kv.get(`global_day_${day}_raised_cents`),
      kv.get(`global_day_${day}_donations_count`),
      kv.get("global_last_update"),
    ]);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      total_cents: Number(total_cents || 0),
      total_count: Number(total_count || 0),
      today_cents: Number(today_cents || 0),
      today_count: Number(today_count || 0),
      updated_at: updated_at || null,
      day_utc: day,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "global stats error" });
  }
}
// /api/global.js
import { kv } from "@vercel/kv";

function todayKeyBerlin() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;

  return `${y}${m}${d}`; // 20260304
}

export default async function handler(req, res) {
  try {
    const day = todayKeyBerlin();

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
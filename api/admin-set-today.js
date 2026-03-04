// /api/admin-set-today.js
import { kv } from "@vercel/kv";

function berlinDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // simple Schutz, sonst kann jeder deine Zahlen setzen
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { today_cents, today_count } = req.body || {};
  const tCents = Number(today_cents);
  const tCount = Number(today_count);

  if (!Number.isFinite(tCents) || tCents < 0) {
    return res.status(400).json({ error: "today_cents invalid" });
  }
  if (!Number.isFinite(tCount) || tCount < 0) {
    return res.status(400).json({ error: "today_count invalid" });
  }

  const day = berlinDayKey(new Date());
  const dayRaisedKey = `global_day_${day}_raised_cents`;
  const dayCountKey = `global_day_${day}_donations_count`;

  // Lock, damit du nicht aus Versehen doppelt nachträgst
  const lockKey = `global_day_${day}_manual_lock`;
  const locked = await kv.get(lockKey);
  if (locked) {
    return res.status(409).json({ error: "already_adjusted_today", day });
  }

  const currentCents = Number((await kv.get(dayRaisedKey)) || 0);
  const currentCount = Number((await kv.get(dayCountKey)) || 0);

  const deltaCents = tCents - currentCents;
  const deltaCount = tCount - currentCount;

  // Setze "heute" hart auf die Stripe-Zahl
  await kv.set(dayRaisedKey, tCents);
  await kv.set(dayCountKey, tCount);

  // Und passe die global totals um die Differenz an (sonst ist global inkonsistent)
  if (deltaCents !== 0) await kv.incrby("global_total_raised_cents", deltaCents);
  if (deltaCount !== 0) await kv.incrby("global_total_donations_count", deltaCount);

  // lock setzen
  await kv.set(lockKey, 1, { ex: 60 * 60 * 24 * 7 }); // 7 Tage reicht

  return res.status(200).json({
    ok: true,
    day,
    before: { currentCents, currentCount },
    after: { today_cents: tCents, today_count: tCount },
    delta: { deltaCents, deltaCount },
  });
}

// /api/raised.js
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const cents = (await kv.get("tour_2026_raised_cents")) || 0;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ raised_cents: Number(cents), goal_cents: 1500000 });
}
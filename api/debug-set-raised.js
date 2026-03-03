import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  await kv.set('tour_2026_raised_cents', 15000);
  return res.status(200).json({ ok: true });
}
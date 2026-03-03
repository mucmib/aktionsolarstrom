// /api/stripe-webhook.js
import Stripe from "stripe";
import { kv } from "@vercel/kv";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Nur Tour zählen
    const isTour = session?.metadata?.bucket === "tour-2026";
    const paid = session?.payment_status === "paid";

    if (isTour && paid) {
      const amount = Number(session?.amount_total || 0); // cents

      // Dedup: event.id + session.id, jeweils mit Ablaufzeit
      const eventKey = `tour_evt_${event.id}`;
      const sessionKey = `tour_sess_${session.id}`;

      const seenEvent = await kv.get(eventKey);
      const seenSession = await kv.get(sessionKey);

      if (seenEvent || seenSession) {
        return res.status(200).json({ received: true, deduped: true });
      }

      // markieren (90 Tage)
      const ttlSeconds = 60 * 60 * 24 * 90;
      await kv.set(eventKey, 1, { ex: ttlSeconds });
      await kv.set(sessionKey, 1, { ex: ttlSeconds });

      // Betrag addieren
      await kv.incrby("tour_2026_raised_cents", amount);

      // Minimal-Log
      await kv.incr("tour_2026_donations_count");
      await kv.set(
        "tour_2026_last_donation",
        JSON.stringify({
          at: new Date().toISOString(),
          amount_cents: amount,
          session_id: session.id,
          event_id: event.id,
        }),
        { ex: ttlSeconds }
      );
    }
  }

  return res.status(200).json({ received: true });
}
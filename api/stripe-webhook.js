// /api/stripe-webhook.js
import Stripe from "stripe";
import { kv } from "@vercel/kv";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Sicherheitscheck: nur Tour zählen
    const isTour = session?.metadata?.bucket === "tour-2026";
    const paid = session.payment_status === "paid";

    if (isTour && paid) {
      const amount = session.amount_total || 0; // in cents
      // Idempotenz: Session-ID einmalig speichern, damit keine Doppelzählung passiert
      const keySeen = `tour_seen_${session.id}`;
      const already = await kv.get(keySeen);

      if (!already) {
        await kv.set(keySeen, 1);
        await kv.incrby("tour_2026_raised_cents", amount);
      }
    }
  }

  res.json({ received: true });
}
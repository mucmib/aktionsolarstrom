// /api/stripe-webhook.js
import Stripe from "stripe";
import { kv } from "@vercel/kv";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Berlin-Tag im Format YYYY-MM-DD (damit "heute" wirklich deutsch passt)
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
  return `${y}-${m}-${d}`; // en-CA liefert genau YYYY-MM-DD
}

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
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Wir zählen nur, wenn die Zahlung wirklich bezahlt ist
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const paid = session?.payment_status === "paid";
    if (!paid) return res.status(200).json({ received: true, ignored: "not_paid" });

    const amount = Number(session?.amount_total || 0); // cents
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(200).json({ received: true, ignored: "no_amount" });
    }

    // Dedup: event.id + session.id, jeweils mit Ablaufzeit
    // (global dedup, nicht nur Tour)
    const eventKey = `glob_evt_${event.id}`;
    const sessionKey = `glob_sess_${session.id}`;

    const seenEvent = await kv.get(eventKey);
    const seenSession = await kv.get(sessionKey);

    if (seenEvent || seenSession) {
      return res.status(200).json({ received: true, deduped: true });
    }

    // markieren (90 Tage)
    const ttlSeconds = 60 * 60 * 24 * 90;
    await kv.set(eventKey, 1, { ex: ttlSeconds });
    await kv.set(sessionKey, 1, { ex: ttlSeconds });

    // Bucket aus metadata (kommt aus create-checkout-session)
    const bucket = String(session?.metadata?.bucket || "unknown");

    // --------
    // GLOBAL: Gesamt + Heute (Berlin)
    // --------
    const day = berlinDayKey(new Date());
    const dayRaisedKey = `global_day_${day}_raised_cents`;
    const dayCountKey = `global_day_${day}_donations_count`;

    await kv.incrby("global_total_raised_cents", amount);
    await kv.incr("global_total_donations_count");

    await kv.incrby(dayRaisedKey, amount);
    await kv.incr(dayCountKey);

    // Optional: Minimal-Log global (letzte Zahlung)
    await kv.set(
      "global_last_donation",
      JSON.stringify({
        at: new Date().toISOString(),
        amount_cents: amount,
        bucket,
        session_id: session.id,
        event_id: event.id,
      }),
      { ex: ttlSeconds }
    );

    // --------
    // TOUR: bleibt wie gehabt (nur wenn bucket == tour-2026)
    // --------
    const isTour = bucket === "tour-2026";
    if (isTour) {
      await kv.incrby("tour_2026_raised_cents", amount);
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
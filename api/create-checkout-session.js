// /api/create-checkout-session.js

console.log("Has STRIPE_SECRET_KEY:", !!process.env.STRIPE_SECRET_KEY);
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Quelle -> Bucket (für globale Auswertung)
 * Passe die source-Strings exakt so an, wie du sie im Frontend sendest.
 */
function getBucket(source) {
  const s = String(source || "").toLowerCase().trim();

  // Tour
  if (s === "tour-landing" || s === "tour") return "tour-2026";

  // Briefseite
  if (s === "brief" || s === "index-full" || s === "briefseite") return "brief";

  // Default: Hauptseite
  return "main";
}

/**
 * Quelle -> Return-Pfad nach Stripe
 * Wichtig: hier deine echten Dateinamen verwenden.
 */
function getReturnPath(source) {
  const s = String(source || "").toLowerCase().trim();

  // Tour
  if (s === "tour-landing" || s === "tour") return "/tour.html";

  // Briefseite: falls deine Seite anders heisst, hier anpassen
  if (s === "brief" || s === "index-full" || s === "briefseite") return "/index-full.html";

  // Hauptseite: falls bei dir indexneu.html oder index.html, hier anpassen
  return "/index.html";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { amount_eur, source } = req.body || {};
    const amount = Number(amount_eur);

    if (!Number.isFinite(amount)) return res.status(400).json({ error: "Invalid amount" });
    if (amount < 1 || amount > 250) return res.status(400).json({ error: "Amount out of range" });

    const unitAmount = Math.round(amount * 100); // cents
    const baseUrl = getBaseUrl(req);

    const bucket = getBucket(source);
    const returnPath = getReturnPath(source);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "sepa_debit", "paypal"],

      // Zuordnung im Stripe Backend
      client_reference_id: bucket,

      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "Unterstützung Aktion Solarstrom",
              description: "Freiwilliger Beitrag zur Finanzierung von Briefdruck und Postversand.",
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],

      success_url: `${baseUrl}${returnPath}?donation=success`,
      cancel_url: `${baseUrl}${returnPath}?donation=cancel`,

      // Immer sauber taggen
      metadata: {
        campaign: "aktion-solarstrom",
        bucket,
        source: String(source || ""),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Stripe error" });
  }
}
// /api/create-checkout-session.js

console.log("Has STRIPE_SECRET_KEY:", !!process.env.STRIPE_SECRET_KEY);
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

function getBaseUrl(req) {
  // Vercel: x-forwarded-proto + x-forwarded-host sind zuverlässig
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getReturnPath(source) {
  // Quelle entscheidet, wohin Stripe zurückleiten soll
  // tour.html sendet z.B. source: 'tour-landing'
  if (String(source || "") === "tour-landing") return "/tour.html";
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

    if (!Number.isFinite(amount)) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (amount < 1 || amount > 250) {
      return res.status(400).json({ error: "Amount out of range" });
    }

    const unitAmount = Math.round(amount * 100); // EUR cents
    const baseUrl = getBaseUrl(req);

    const returnPath = getReturnPath(source);

    // Für Tour-Zahlungen markieren wir metadata + client_reference_id
    const isTour = String(source || "") === "tour-landing";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "sepa_debit", "paypal"], // PayPal nur wenn in deinem Stripe-Account aktiv

      // Das ist der "Beleg" / Zuordnung im Stripe-Backend
      client_reference_id: isTour ? "tour-2026" : undefined,

      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "Unterstützung Aktion Solarstrom",
              description:
                "Freiwilliger Beitrag zur Finanzierung von Briefdruck und Postversand.",
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],

      success_url: `${baseUrl}${returnPath}?donation=success`,
      cancel_url: `${baseUrl}${returnPath}?donation=cancel`,

      // metadata existierte schon -> wir erweitern es
      metadata: {
        source: String(source || "indexneu"),

        // Nur für Tour-Zahlungen setzen
        ...(isTour
          ? {
              campaign: "aktion-solarstrom",
              bucket: "tour-2026",
            }
          : {}),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Stripe error" });
  }
}
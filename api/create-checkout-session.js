//api/create-checkoout-session.js

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

function getBaseUrl(req) {
  // Vercel: x-forwarded-proto + x-forwarded-host sind zuverlässig
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amount_eur, source } = req.body || {};
    const amount = Number(amount_eur);

    if (!Number.isFinite(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (amount < 1 || amount > 250) {
      return res.status(400).json({ error: 'Amount out of range' });
    }

    const unitAmount = Math.round(amount * 100); // EUR cents

    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'sepa_debit', 'paypal'], // paypal nur wenn in deinem Stripe-Account aktiv
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Unterstützung Aktion Solarstrom',
              description: 'Freiwilliger Beitrag zur Finanzierung von Briefdruck und Postversand.',
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/indexneu.html?donation=success`,
      cancel_url: `${baseUrl}/indexneu.html?donation=cancel`,
      metadata: {
        source: String(source || 'indexneu'),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Stripe error' });
  }
}
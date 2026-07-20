#!/usr/bin/env node
/**
 * One-time bootstrap: create the founders offer in Stripe.
 *
 *   Product: "Desktop Kitchen — Plan Fundadores"
 *   Price:   $799 MXN / month, lookup_key 'dk_founders_799'
 *
 * Idempotent — if a price with the lookup_key already exists it is printed
 * and nothing is created. Run with prod or test keys:
 *
 *   node scripts/create-founders-price.mjs
 *
 * Then set the printed id as STRIPE_PRICE_FOUNDERS in Railway (and .env).
 */
import 'dotenv/config';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set');
  process.exit(1);
}
const stripe = new Stripe(key);
const LOOKUP_KEY = 'dk_founders_799';

const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], limit: 1 });
if (existing.data.length > 0) {
  const p = existing.data[0];
  console.log(`Founders price already exists: ${p.id} (${p.unit_amount / 100} ${p.currency.toUpperCase()}/${p.recurring?.interval})`);
  console.log(`\nSTRIPE_PRICE_FOUNDERS=${p.id}`);
  process.exit(0);
}

const product = await stripe.products.create({
  name: 'Desktop Kitchen — Plan Fundadores',
  description: 'Precio de fundador: $799 MXN/mes congelado de por vida. Incluye POS, kiosco, KDS, menú QR, inventario, CFDI y todo el plan Pro.',
});

const price = await stripe.prices.create({
  product: product.id,
  unit_amount: 79900,
  currency: 'mxn',
  recurring: { interval: 'month' },
  lookup_key: LOOKUP_KEY,
  nickname: 'Fundadores $799 MXN/mes (de por vida)',
});

console.log(`Created product ${product.id}`);
console.log(`Created price   ${price.id} — $799 MXN/month`);
console.log(`\nSet this in Railway + .env:\n\nSTRIPE_PRICE_FOUNDERS=${price.id}`);

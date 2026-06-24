// api/cakto-webhook.js — Vercel Serverless Function
// Handles all Cakto subscription webhook events

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CAKTO_WEBHOOK_SECRET = process.env.CAKTO_WEBHOOK_SECRET;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function logEvent(sb, eventType, payload, processed, error = null) {
  await sb.from('cakto_events').insert({
    event_type: eventType,
    payload,
    processed,
    error,
  });
}

async function handlePurchaseApproved(sb, payload) {
  const email = payload?.customer?.email || payload?.buyer?.email;
  const planId = payload?.product?.code || payload?.items?.[0]?.code || 'monthly';
  const orderId = payload?.order?.code || payload?.id;
  const amount = payload?.order?.amount || payload?.amount || 0;
  const paymentMethod = payload?.payment?.method || payload?.payment_method || 'card';
  const caktoSubId = payload?.subscription?.code || payload?.subscription_id || null;

  if (!email) throw new Error('No customer email in payload');

  // Map plan price to plan id
  const PLAN_MAP = {
    'mensal': { name: 'Plano Mensal', price: 57.90, id: 'monthly' },
    'trimestral': { name: 'Plano Trimestral', price: 147.90, id: 'quarterly' },
    'anual': { name: 'Plano Anual', price: 497.90, id: 'annual' },
    'monthly': { name: 'Plano Mensal', price: 57.90, id: 'monthly' },
    'quarterly': { name: 'Plano Trimestral', price: 147.90, id: 'quarterly' },
    'annual': { name: 'Plano Anual', price: 497.90, id: 'annual' },
  };
  const plan = PLAN_MAP[planId] || { name: 'Plano', price: amount / 100, id: planId };

  const now = new Date();
  const nextBilling = new Date(now);
  if (plan.id === 'monthly') nextBilling.setMonth(nextBilling.getMonth() + 1);
  else if (plan.id === 'quarterly') nextBilling.setMonth(nextBilling.getMonth() + 3);
  else if (plan.id === 'annual') nextBilling.setFullYear(nextBilling.getFullYear() + 1);

  // Upsert subscription
  const { data: sub } = await sb.from('shop_subscriptions').upsert({
    email,
    plan_id: plan.id,
    plan_name: plan.name,
    price: plan.price,
    status: 'active',
    sub_start: now.toISOString(),
    next_billing: nextBilling.toISOString(),
    cakto_sub_id: caktoSubId,
    cakto_order_id: orderId,
    trial_end: now.toISOString(), // trial ended
    updated_at: now.toISOString(),
  }, { onConflict: 'email' }).select().single();

  // Record payment
  await sb.from('shop_payments').insert({
    email,
    subscription_id: sub?.id || null,
    cakto_order_id: orderId,
    plan_id: plan.id,
    amount: amount / 100,
    status: 'approved',
    payment_method: paymentMethod,
  });
}

async function handleSubscriptionCreated(sb, payload) {
  return handlePurchaseApproved(sb, payload);
}

async function handleSubscriptionRenewed(sb, payload) {
  const email = payload?.customer?.email || payload?.buyer?.email;
  const orderId = payload?.order?.code || payload?.id;
  const amount = payload?.order?.amount || payload?.amount || 0;
  const planId = payload?.product?.code || 'monthly';
  const caktoSubId = payload?.subscription?.code || null;

  if (!email) throw new Error('No email for renewal');

  const { data: sub } = await sb.from('shop_subscriptions').select('*').eq('email', email).maybeSingle();
  const existingPlanId = sub?.plan_id || planId;
  const now = new Date();
  const next = new Date(now);
  if (existingPlanId === 'monthly') next.setMonth(next.getMonth() + 1);
  else if (existingPlanId === 'quarterly') next.setMonth(next.getMonth() + 3);
  else if (existingPlanId === 'annual') next.setFullYear(next.getFullYear() + 1);

  await sb.from('shop_subscriptions').upsert({
    email, status: 'active', next_billing: next.toISOString(), cakto_sub_id: caktoSubId, cakto_order_id: orderId, updated_at: now.toISOString(),
  }, { onConflict: 'email' });

  await sb.from('shop_payments').insert({
    email, subscription_id: sub?.id || null, cakto_order_id: orderId, plan_id: existingPlanId,
    amount: amount / 100, status: 'approved', payment_method: 'subscription',
  });
}

async function handleSubscriptionCancelled(sb, payload) {
  const email = payload?.customer?.email || payload?.buyer?.email;
  if (!email) throw new Error('No email for cancellation');
  await sb.from('shop_subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('email', email);
}

async function handleRenewalRefused(sb, payload) {
  const email = payload?.customer?.email || payload?.buyer?.email;
  const orderId = payload?.order?.code || payload?.id;
  const amount = payload?.order?.amount || 0;
  if (!email) throw new Error('No email for refused renewal');

  await sb.from('shop_subscriptions').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('email', email);
  await sb.from('shop_payments').insert({
    email, cakto_order_id: orderId, amount: amount / 100, status: 'refused', payment_method: 'subscription',
  });
}

async function handlePurchaseRefused(sb, payload) {
  const email = payload?.customer?.email || payload?.buyer?.email;
  const orderId = payload?.order?.code || payload?.id;
  const amount = payload?.order?.amount || 0;
  if (!email) return; // new customer refused — nothing to update
  await sb.from('shop_payments').insert({
    email, cakto_order_id: orderId, amount: amount / 100, status: 'refused', payment_method: payload?.payment?.method || 'card',
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const secret = body?.secret || req.headers['x-cakto-secret'];

  // Validate webhook secret
  if (CAKTO_WEBHOOK_SECRET && secret !== CAKTO_WEBHOOK_SECRET) {
    console.warn('Invalid webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const eventType = body?.event || body?.type || 'unknown';
  const sb = getSupabase();

  try {
    switch (eventType) {
      case 'purchase_approved':
        await handlePurchaseApproved(sb, body);
        break;
      case 'subscription_created':
        await handleSubscriptionCreated(sb, body);
        break;
      case 'subscription_renewed':
        await handleSubscriptionRenewed(sb, body);
        break;
      case 'subscription_canceled':
      case 'subscription_cancelled':
        await handleSubscriptionCancelled(sb, body);
        break;
      case 'subscription_renewal_refused':
        await handleRenewalRefused(sb, body);
        break;
      case 'purchase_refused':
        await handlePurchaseRefused(sb, body);
        break;
      default:
        console.log('Unknown event type:', eventType);
    }
    await logEvent(sb, eventType, body, true);
    return res.status(200).json({ ok: true, event: eventType });
  } catch (err) {
    console.error('Webhook error:', err.message);
    await logEvent(sb, eventType, body, false, err.message);
    return res.status(500).json({ error: err.message });
  }
};

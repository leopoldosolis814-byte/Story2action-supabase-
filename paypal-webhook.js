// api/paypal-webhook.js
// Vercel Serverless Function — valida webhooks de PayPal server-side

const PLAN_ACTIVAS = {
  'P-23B493830J7534834NHQ5G6Q': '1,2,3,4',
  'P-2TG94582K0155811NNHQ5KLY': '1,2,13,14',
  'P-5MV130026J4036916NHQ5MCY': '1,2,3,13,14,15',
  'P-4B114925PS7553024NHQ5OBI': '1,2,13,14',
  'P-94M604034J491873TNHQ5PPA': '1,13,14,15',
  'P-88B92692ER102991YNHQ5Q5Y': '1,2,13,14,15,16',
  'P-1FU869136L951873KNHQ5SNA': '1,13,14,15',
  'P-4FJ199159J267321DNHQ5UIY': '13,14,15,16',
  'P-61S525445R303490MNHQ5VQY': '13,14,15,16',
};

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  return data.access_token;
}

async function verifyWebhookSignature(headers, body, accessToken) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  const res = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transmission_id: headers['paypal-transmission-id'],
      transmission_time: headers['paypal-transmission-time'],
      cert_url: headers['paypal-cert-url'],
      auth_algo: headers['paypal-auth-algo'],
      transmission_sig: headers['paypal-transmission-sig'],
      webhook_id: webhookId,
      webhook_event: JSON.parse(body),
    }),
  });

  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

async function activarAccesoEnSupabase(subscriptionId, planId, email) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const activas = PLAN_ACTIVAS[planId] || '1,2,3,4';

  // Verificar idempotencia — evitar duplicados
  const checkRes = await fetch(
    `${supabaseUrl}/rest/v1/s2a_accesos?subscription_id=eq.${subscriptionId}`,
    {
      headers: {
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
    }
  );
  const existing = await checkRes.json();
  if (existing.length > 0) {
    console.log('Acceso ya registrado, ignorando duplicado');
    return;
  }

  // Insertar nuevo acceso
  await fetch(`${supabaseUrl}/rest/v1/s2a_accesos`, {
    method: 'POST',
    headers: {
      'apikey': supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      subscription_id: subscriptionId,
      plan_id: planId,
      activas: activas,
      email: email || null,
      activado_en: new Date().toISOString(),
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = JSON.stringify(req.body);
    const accessToken = await getPayPalAccessToken();
    const isValid = await verifyWebhookSignature(req.headers, rawBody, accessToken);

    if (!isValid) {
      console.error('Firma de webhook inválida');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body;
    const eventType = event.event_type;

    // Solo procesar suscripciones activadas
    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const subscriptionId = event.resource?.id;
      const planId = event.resource?.plan_id;
      const email = event.resource?.subscriber?.email_address;

      if (subscriptionId && planId) {
        await activarAccesoEnSupabase(subscriptionId, planId, email);
        console.log(`Acceso activado: ${subscriptionId} plan: ${planId}`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

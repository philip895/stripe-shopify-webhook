
// server.js
// Webhook che collega Stripe a Shopify:
// quando un pagamento su Stripe va a buon fine, cerca l'ordine Shopify
// corrispondente (per email cliente) e lo segna automaticamente come pagato.
const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = "2025-01";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const SENDER_NAME = process.env.SENDER_NAME || "Outfit del Calcio";
const OUR_SERVER_URL = process.env.OUR_SERVER_URL;

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getShopifyAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }
  const url = `https://${SHOPIFY_STORE}/admin/oauth/access_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Errore nell'ottenere il token Shopify: ${errText}`);
  }
  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 23 * 60 * 60 * 1000);
  return cachedToken;
}

app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Firma webhook non valida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;

    if (!customerEmail) {
      console.error("❌ Nessuna email trovata nella sessione Stripe");
      return res.status(200).json({ received: true, error: "no_email" });
    }

    console.log(`✅ Pagamento completato per: ${customerEmail}`);

    try {
      const orderId = await findUnpaidShopifyOrderByEmail(customerEmail);
      if (!orderId) {
        console.warn(`⚠️ Nessun ordine Shopify trovato per ${customerEmail}`);
        return res.status(200).json({ received: true, order_found: false });
      }
      await markShopifyOrderAsPaid(orderId);
      console.log(`💰 Ordine ${orderId} segnato come pagato su Shopify`);
      return res.status(200).json({ received: true, order_id: orderId });
    } catch (err) {
      console.error("❌ Errore durante l'elaborazione:", err.message);
      return res.status(200).json({ received: true, error: err.message });
    }
  }
);

app.get("/", (req, res) => {
  res.send("Stripe → Shopify webhook attivo ✅");
});

const crypto = require("crypto");

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;
  const generatedHash = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(req.body).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
}

app.post(
  "/webhook/shopify/order-created",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!verifyShopifyWebhook(req)) {
      console.error("❌ Webhook Shopify non autentico, scartato");
      return res.status(401).send("Invalid signature");
    }
    res.status(200).send("ok");

    let order;
    try {
      order = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      console.error("❌ Impossibile leggere l'ordine ricevuto:", err.message);
      return;
    }

    const customerEmail = order.email || order.contact_email;
    const customerName = order.customer?.first_name || "";
    const orderName = order.name;

    if (!customerEmail) {
      console.warn(`⚠️ Ordine ${orderName} senza email cliente, email non inviata`);
      return;
    }

    console.log(`📦 Nuovo ordine rilevato: ${orderName} per ${customerEmail}`);

    try {
      await sendThankYouEmail({ to: customerEmail, name: customerName, orderName });
      console.log(`✉️ Email di ringraziamento inviata a ${customerEmail}`);
    } catch (err) {
      console.error("❌ Errore nell'invio dell'email:", err.message);
    }
  }
);

async function sendThankYouEmail({ to, name, orderName }) {
  const greeting = name ? `Ciao ${name}` : "Ciao";
 const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
        <div style="background-color: #d4ff3f; text-align: center; padding: 24px;">
          <strong style="font-size: 20px;">⚽ L'OUTFIT DEL CALCIO</strong>
        </div>
        <h1 style="text-align: center; font-size: 28px; margin-top: 32px;">Ti diamo il benvenuto</h1>
        <p style="text-align: center;">${greeting},</p>
        <p style="text-align: center;">
          Che tu stia cercando la maglia della tua squadra del cuore, un pezzo introvabile da vero collezionista,
          o l'outfit perfetto per il prossimo grande torneo mondiale — qui trovi il tuo prossimo acquisto del cuore.
        </p>
        <p style="text-align: center; font-weight: bold;">
          🔥 Le maglie che i nostri clienti si stanno letteralmente contendendo
        </p>
        <p style="text-align: center;">
          Ogni settimana ne restano sempre meno in stock. Guarda cosa sta andando a ruba proprio ora.
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="https://outfitdelcalcio.com/collections/nuovi-arrivi?utm_source=email&utm_medium=newsletter&utm_campaign=nuovi_arrivi" style="background-color: #d4ff3f; color: #000; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">
            Nuovi Arrivi
          </a>
        </div>
        <h3 style="text-align: center;">Perché scegliere Outfit Del Calcio:</h3>
        <p style="text-align: center;">⚽ Maglie delle squadre più amate</p>
        <p style="text-align: center;">⚽ Qualità che senti addosso, non solo che vedi</p>
        <p style="text-align: center;">⚽ Personalizzazione con nome e numero, come allo stadio</p>
        <p style="text-align: center;">⚽ Spedizione veloce, resi senza stress</p>
        <p style="text-align: center; margin-top: 32px;">
          A presto in campo,<br/>Il team di ${SENDER_NAME}
        </p>
      </div>
    `;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to: [to],
      subject: "Grazie per il tuo ordine! 🎉",
      html,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend ha rifiutato l'invio: ${errText}`);
  }
  return response.json();
}

async function registerOrderWebhook() {
  const accessToken = await getShopifyAccessToken();
  const callbackUrl = `${OUR_SERVER_URL}/webhook/shopify/order-created`;
  const listUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`;
  const listResp = await fetch(listUrl, { headers: { "X-Shopify-Access-Token": accessToken } });
  const listData = await listResp.json();

  const alreadyExists = (listData.webhooks || []).some(
    (w) => w.topic === "orders/create" && w.address === callbackUrl
  );
  if (alreadyExists) {
    console.log("ℹ️ Webhook orders/create già registrato, nessuna azione necessaria");
    return;
  }

  const createResp = await fetch(listUrl, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook: { topic: "orders/create", address: callbackUrl, format: "json" } }),
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    console.error("❌ Errore nella registrazione del webhook:", errText);
    return;
  }
  console.log("✅ Webhook orders/create registrato con successo su Shopify");
}
// ===== SECONDA EMAIL: INVIATA QUANDO SHOPIFY SEGNA L'ORDINE COME PAGATO =====
app.post(
  "/webhook/shopify/order-paid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!verifyShopifyWebhook(req)) {
      console.error("❌ Webhook pagamento non autentico, scartato");
      return res.status(401).send("Invalid signature");
    }
    res.status(200).send("ok");

    let order;
    try {
      order = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      console.error("❌ Impossibile leggere l'ordine pagato:", err.message);
      return;
    }

    const customerEmail = order.email || order.contact_email;
    const customerName = order.customer?.first_name || "";
    const orderName = order.name;

    if (!customerEmail) {
      console.warn(`⚠️ Ordine ${orderName} pagato ma senza email cliente`);
      return;
    }

    console.log(`💳 Ordine pagato: ${orderName} per ${customerEmail}`);

    try {
      await sendPaymentConfirmedEmail({ to: customerEmail, name: customerName, orderName });
      console.log(`✉️ Email conferma pagamento inviata a ${customerEmail}`);
    } catch (err) {
      console.error("❌ Errore nell'invio dell'email di pagamento:", err.message);
    }
  }
);

async function sendPaymentConfirmedEmail({ to, name, orderName }) {
  const greeting = name ? `Ciao ${name}` : "Ciao";

  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
        <div style="background-color: #d4ff3f; text-align: center; padding: 24px;">
          <strong style="font-size: 20px;">⚽ L'OUTFIT DEL CALCIO</strong>
        </div>
        <h1 style="text-align: center; font-size: 28px; margin-top: 32px;">⚽ Grazie per il tuo ordine!</h1>
        <p style="text-align: center;">${greeting},</p>
        <p style="text-align: center;">
          Grazie di cuore per il tuo ordine <strong>${orderName}</strong>!
        </p>
        <p style="text-align: center;">
          Il tuo pacco è già in lavorazione e presto sarà in viaggio verso di te.
        </p>

        <h3 style="text-align: center; margin-top: 32px;">📲 Unisciti al nostro canale Telegram</h3>
        <p style="text-align: center;">
          Ricevi novità e codici sconto esclusivi. Iscrivendoti ricevi subito il <strong>20% di sconto</strong>
          sul prossimo ordine con il codice <strong>TELEGRAM20</strong>.
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="https://t.me/+R-i_B3XKj6Q4ZTE0" style="background-color: #d4ff3f; color: #000; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">
            Entra nel canale Telegram
          </a>
        </div>

        <h3 style="text-align: center; margin-top: 32px;">⭐ Lascia una recensione</h3>
        <p style="text-align: center;">
          Quando il tuo ordine arriva, raccontaci cosa ne pensi e ricevi un ulteriore codice sconto.
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="https://outfitdelcalcio.com/?utm_source=email&utm_medium=transazionale&utm_campaign=recensione" style="background-color: #d4ff3f; color: #000; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">
            Lascia una recensione
          </a>
        </div>

        <p style="text-align: center; margin-top: 32px;">
          A presto in campo,<br/>Il team di ${SENDER_NAME}
        </p>
      </div>
    `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to: [to],
      subject: `⚽ Grazie per il tuo ordine ${orderName}!`,
      html,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend ha rifiutato l'invio: ${errText}`);
  }
  return response.json();
}

async function registerPaidOrderWebhook() {
  const accessToken = await getShopifyAccessToken();
  const callbackUrl = `${OUR_SERVER_URL}/webhook/shopify/order-paid`;
  const listUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`;
  const listResp = await fetch(listUrl, { headers: { "X-Shopify-Access-Token": accessToken } });
  const listData = await listResp.json();

  const alreadyExists = (listData.webhooks || []).some(
    (w) => w.topic === "orders/paid" && w.address === callbackUrl
  );
  if (alreadyExists) {
    console.log("ℹ️ Webhook orders/paid già registrato, nessuna azione necessaria");
    return;
  }

  const createResp = await fetch(listUrl, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook: { topic: "orders/paid", address: callbackUrl, format: "json" } }),
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    console.error("❌ Errore nella registrazione del webhook orders/paid:", errText);
    return;
  }
  console.log("✅ Webhook orders/paid registrato con successo su Shopify");
}

async function findUnpaidShopifyOrderByEmail(email) {
  const accessToken = await getShopifyAccessToken();
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?email=${encodeURIComponent(email)}&financial_status=pending&status=any&limit=1`;
  const response = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Errore nella ricerca ordine Shopify: ${response.status}`);
  }
  const data = await response.json();
  if (!data.orders || data.orders.length === 0) return null;
  return data.orders[0].id;
}

async function markShopifyOrderAsPaid(orderId) {
  const accessToken = await getShopifyAccessToken();
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/transactions.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: { kind: "sale", status: "success" } }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Errore nel segnare l'ordine come pagato: ${errText}`);
  }
  return response.json();
}

// ===== PAGAMENTI PAYPAL: SEGNA L'ORDINE COME PAGATO SU SHOPIFY =====

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const PAYPAL_API = "https://api-m.paypal.com";

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`Errore token PayPal: ${await response.text()}`);
  const data = await response.json();
  return data.access_token;
}

async function verifyPayPalWebhook(req, rawBody) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_API}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: req.get("paypal-auth-algo"),
      cert_url: req.get("paypal-cert-url"),
      transmission_id: req.get("paypal-transmission-id"),
      transmission_sig: req.get("paypal-transmission-sig"),
      transmission_time: req.get("paypal-transmission-time"),
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody.toString("utf8")),
    }),
  });
  const data = await response.json();
  return data.verification_status === "SUCCESS";
}

async function findPendingOrdersByAmount(amount, currency) {
  const accessToken = await getShopifyAccessToken();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?financial_status=pending&status=any&created_at_min=${encodeURIComponent(since)}&limit=250`;
  const response = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!response.ok) throw new Error(`Errore ricerca ordini: ${response.status}`);
  const data = await response.json();
  return (data.orders || []).filter(
    (o) => Number(o.total_price) === Number(amount) && o.currency === currency
  );
}

async function avvisaPagamentoDaControllare({ amount, currency, payerEmail, candidati }) {
  const elenco = candidati.length
    ? candidati.map((o) => `<p>${o.name} — ${o.total_price} ${o.currency} — ${o.email || "senza email"}</p>`).join("")
    : "<p>Nessun ordine in attesa con questo importo nelle ultime 24 ore.</p>";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to: [SENDER_EMAIL],
      subject: `⚠️ Pagamento PayPal da abbinare a mano — ${amount} ${currency}`,
      html: `
        <p>È arrivato un pagamento PayPal che non sono riuscito ad abbinare con certezza.</p>
        <p><strong>Importo:</strong> ${amount} ${currency}<br/>
           <strong>Pagante:</strong> ${payerEmail || "non fornito"}</p>
        <p><strong>Ordini in attesa con lo stesso importo:</strong></p>
        ${elenco}
        <p>Apri Shopify e segna a mano l'ordine corretto come pagato.</p>
      `,
    }),
  });
}

app.post("/webhook/paypal", express.raw({ type: "application/json" }), async (req, res) => {
  res.status(200).send("ok");

  let evento;
  try {
    const valido = await verifyPayPalWebhook(req, req.body);
    if (!valido) {
      console.error("❌ Notifica PayPal non verificata, scartata");
      return;
    }
    evento = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("❌ Errore nella verifica della notifica PayPal:", err.message);
    return;
  }

  if (evento.event_type !== "PAYMENT.CAPTURE.COMPLETED") return;

  const amount = evento.resource?.amount?.value;
  const currency = evento.resource?.amount?.currency_code;
  const payerEmail = evento.resource?.payer?.email_address || "";

  console.log(`💶 Incasso PayPal: ${amount} ${currency} da ${payerEmail || "email non fornita"}`);

  try {
    const candidati = await findPendingOrdersByAmount(amount, currency);

    if (candidati.length === 1) {
      await markShopifyOrderAsPaid(candidati[0].id);
      console.log(`💰 Ordine ${candidati[0].name} segnato come pagato via PayPal`);
    } else {
      console.warn(`⚠️ Abbinamento incerto: ${candidati.length} ordini con importo ${amount}`);
      await avvisaPagamentoDaControllare({ amount, currency, payerEmail, candidati });
    }
  } catch (err) {
    console.error("❌ Errore nell'abbinamento del pagamento PayPal:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
  registerOrderWebhook().catch((err) =>
    console.error("❌ Errore nella registrazione automatica del webhook:", err.message)
  );
  registerPaidOrderWebhook().catch((err) =>
    console.error("❌ Errore nella registrazione del webhook orders/paid:", err.message)
  );
});

// ===== RIEPILOGO GIORNALIERO ORDINI DA PRODURRE =====

const RIEPILOGO_TOKEN = process.env.RIEPILOGO_TOKEN;

async function getOrdiniDaProdurre() {
  const accessToken = await getShopifyAccessToken();
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?financial_status=paid&fulfillment_status=unfulfilled&status=open&limit=250`;
  const response = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!response.ok) throw new Error(`Errore nel recupero ordini: ${response.status}`);
  const data = await response.json();
  return data.orders || [];
}

function formattaOrdine(ordine) {
  const righe = [];
  righe.push(`━━━━━━━━━━━━━━━━━━━━`);
  righe.push(`ORDINE ${ordine.name}`);
  righe.push(``);

  for (const item of ordine.line_items || []) {
    righe.push(`${item.quantity}x ${item.title}`);
    for (const p of item.properties || []) {
      if (!p.name || String(p.name).startsWith("_")) continue;
      righe.push(`   ${p.name}: ${p.value}`);
    }
    righe.push(``);
  }

  const sp = ordine.shipping_address;
  if (sp) {
    righe.push(`SPEDIRE A:`);
    righe.push(sp.name || "");
    righe.push(sp.address1 || "");
    if (sp.address2) righe.push(sp.address2);
    righe.push(`${sp.zip || ""} ${sp.city || ""} ${sp.province_code || ""}`.trim());
    righe.push(sp.country || "");
    if (sp.phone) righe.push(`Tel: ${sp.phone}`);
  } else {
    righe.push(`⚠️ INDIRIZZO MANCANTE`);
  }
  righe.push(``);
  return righe.join("\n");
}

app.get("/riepilogo-ordini", async (req, res) => {
  if (req.query.token !== RIEPILOGO_TOKEN) {
    return res.status(401).send("Non autorizzato");
  }
  res.status(200).send("ok");

  try {
    const ordini = await getOrdiniDaProdurre();

    if (ordini.length === 0) {
      console.log("ℹ️ Nessun ordine da produrre, nessuna email inviata");
      return;
    }

    const testo = ordini.map(formattaOrdine).join("\n");
    const oggi = new Date().toLocaleDateString("it-IT");

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
        to: [SENDER_EMAIL],
        subject: `📦 ${ordini.length} ordini da produrre — ${oggi}`,
        html: `<p>Ordini pagati e non ancora spediti al ${oggi}.<br/>
               Copia il blocco qui sotto e incollalo nel gruppo.</p>
               <pre style="font-family: monospace; font-size: 14px; white-space: pre-wrap;">${testo
                 .replace(/&/g, "&amp;")
                 .replace(/</g, "&lt;")
                 .replace(/>/g,

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

const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // es: outfitdelcalcio.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = "2025-01"; // aggiornabile in futuro

// Il token di accesso Shopify non è più statico (cambio di sistema
// Shopify da gennaio 2026): lo richiediamo automaticamente qui,
// e lo teniamo in memoria finché è valido, per non richiederlo
// ad ogni singola chiamata.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getShopifyAccessToken() {
  const now = Date.now();

  // Se abbiamo già un token valido in memoria, riusalo
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
  // Il token dura in genere 24 ore: lo rinnoviamo un po' prima per sicurezza
  cachedTokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 23 * 60 * 60 * 1000);

  return cachedToken;
}

// IMPORTANTE: per verificare la firma del webhook Stripe,
// serve il "raw body" della richiesta, non il JSON già parsato.
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    // 1. Verifica che la richiesta arrivi davvero da Stripe
    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Firma webhook non valida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 2. Ci interessa solo l'evento "checkout.session.completed"
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;
    const customerEmail =
      session.customer_details?.email || session.customer_email;

    if (!customerEmail) {
      console.error("❌ Nessuna email trovata nella sessione Stripe");
      return res.status(200).json({ received: true, error: "no_email" });
    }

    console.log(`✅ Pagamento completato per: ${customerEmail}`);

    try {
      // 3. Cerca l'ordine Shopify più recente con quella email,
      //    non ancora pagato
      const orderId = await findUnpaidShopifyOrderByEmail(customerEmail);

      if (!orderId) {
        console.warn(`⚠️ Nessun ordine Shopify trovato per ${customerEmail}`);
        return res.status(200).json({ received: true, order_found: false });
      }

      // 4. Segna l'ordine come pagato
      await markShopifyOrderAsPaid(orderId);
      console.log(`💰 Ordine ${orderId} segnato come pagato su Shopify`);

      return res.status(200).json({ received: true, order_id: orderId });
    } catch (err) {
      console.error("❌ Errore durante l'elaborazione:", err.message);
      return res.status(200).json({ received: true, error: err.message });
    }
  }
);

// Route di controllo, utile per verificare che il server sia online
app.get("/", (req, res) => {
  res.send("Stripe → Shopify webhook attivo ✅");
});

/**
 * Cerca su Shopify l'ordine più recente non pagato associato a un'email.
 */
async function findUnpaidShopifyOrderByEmail(email) {
  const accessToken = await getShopifyAccessToken();

  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?email=${encodeURIComponent(
    email
  )}&financial_status=pending&status=any&limit=1`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Errore nella ricerca ordine Shopify: ${response.status}`);
  }

  const data = await response.json();
  if (!data.orders || data.orders.length === 0) return null;

  return data.orders[0].id;
}

/**
 * Segna un ordine Shopify come pagato tramite l'API REST
 * (crea una transazione di tipo "sale" per l'importo dovuto).
 */
async function markShopifyOrderAsPaid(orderId) {
  const accessToken = await getShopifyAccessToken();

  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/transactions.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transaction: {
        kind: "sale",
        status: "success",
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Errore nel segnare l'ordine come pagato: ${errText}`);
  }

  return response.json();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});

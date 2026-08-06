# Stripe → Shopify: segna ordini come pagati in automatico

Questo piccolo programma fa una cosa sola: quando un cliente paga su
Stripe, cerca l'ordine corrispondente su Shopify (tramite la sua email)
e lo segna automaticamente come "Pagato" — senza bisogno di farlo a mano.

Segui questi passaggi **nell'ordine esatto**.

---

## 1. Crea un'app su Shopify (per ottenere Client ID e Client Secret)

Da gennaio 2026 Shopify non mostra più un token statico da copiare:
il nostro codice lo richiede automaticamente usando due credenziali,
Client ID e Client Secret, che tu ottieni una sola volta così:

1. Vai su **Shopify Admin → Impostazioni → App e canali di vendita**
2. Clicca su **"Sviluppa app"**, poi crea o apri la tua app
3. Vai su **"Impostazioni"** dell'app e abilita/verifica questi
   permessi (scope) nella sezione API:
   - `read_orders`
   - `write_orders`
4. Salva
5. Sempre in **"Impostazioni"**, trova la sezione con **"ID client"**
   e **"Segreto"** — copia entrambi i valori
   → sono i tuoi `SHOPIFY_CLIENT_ID` e `SHOPIFY_CLIENT_SECRET`
6. **Installa l'app** sul tuo negozio, se non l'hai già fatto (da
   Impostazioni → App e canali di vendita → clicca sulla tua app →
   "Installa app")
7. Il tuo `SHOPIFY_STORE` è il dominio che vedi nell'URL del tuo admin,
   tipo `nometuonegozio.myshopify.com`

Il codice (`server.js`) si occupa da solo di scambiare queste due
credenziali con un token di accesso valido ogni volta che serve — non
devi fare nessuna richiesta manuale.

---

## 2. Metti online il codice (hosting gratuito)

Consigliato: **Render.com** (ha un piano gratuito sufficiente per iniziare).

1. Crea un account gratuito su render.com
2. Carica questo progetto su GitHub (fatto!)
3. Su Render, clicca **"New +" → "Web Service"**
4. Collega il repository GitHub appena creato
5. Imposta:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
6. Nella sezione **"Environment Variables"** di Render, inserisci le
   stesse variabili del file `.env.example` (incluse `SHOPIFY_CLIENT_ID`
   e `SHOPIFY_CLIENT_SECRET`), con i tuoi valori reali
   (tranne `STRIPE_WEBHOOK_SECRET`, che otterrai al passaggio 3)
7. Clicca **"Create Web Service"** e attendi il deploy
8. Una volta online, Render ti darà un indirizzo tipo:
   `https://tuoprogetto.onrender.com`

---

## 3. Collega il webhook su Stripe

1. Vai su **Stripe Dashboard → Developers → Webhooks**
2. Clicca **"Add endpoint"**
3. Come URL, inserisci:
   `https://tuoprogetto.onrender.com/webhook/stripe`
4. Come evento da ascoltare, seleziona **"checkout.session.completed"**
5. Salva: Stripe ti mostrerà un **"Signing secret"** (inizia con `whsec_...`)
6. Copia quel valore e inseriscilo su Render come variabile
   `STRIPE_WEBHOOK_SECRET`
7. Riavvia il servizio su Render perché legga la nuova variabile

---

## 4. Test finale

1. Fai un pagamento di prova reale (anche di importo minimo) sul tuo sito
2. Controlla i log del servizio su Render (sezione "Logs")
3. Vai su Shopify e verifica che l'ordine risulti "Pagato"

---

## Note importanti

- Il file `.env` contiene le tue chiavi segrete: non condividerlo mai
- Se in futuro vuoi passare dalle chiavi Stripe di test a quelle live,
  ricordati di creare un nuovo webhook endpoint anche in modalità live

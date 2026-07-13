# EstatePay — Real Production Build

This replaces the simulator's fake in-memory database and fake M-Pesa/WhatsApp
with a real backend. Here's exactly what's real, what's simplified, and the
exact steps to get it live.

## What's actually real now

- **Auth**: Firebase Phone Authentication (real SMS OTP), not the simulator's fake email/password.
- **Database**: Real Cloud Firestore, with security rules that block all direct client writes to `tenants`, `bills`, `transactions`, and `units` — everything sensitive goes through Cloud Functions.
- **Payments**: Real Safaricom Daraja STK Push (`initiateStkPush`) and real callback handling (`mpesaCallback`) that updates bill balances and marks bills paid.
- **WhatsApp**: Real Twilio webhook (`whatsappWebhook`) with a Firestore-backed conversation state machine — onboarding, bill view, pay, account details, forum.
- **Billing**: Real scheduled Cloud Function (`generateMonthlyBills`) that runs daily and bills each estate on its own `billingDay`, plus a manual `runBillingNow` for admins.
- **Household logic**: `registerHousehold`, `generateHouseholdInvite`, `redeemHouseholdInvite` — first resident owns the house, everyone else must use the invite link, exactly as your spec required.
- **Forum**: Real `createAnnouncement` (committee/admin only), `createDiscussionPost`, `createReply`.
- **Custom claims**: An `onTenantWrite` trigger keeps each user's `role`/`estateId`/`unitId` claims in sync automatically whenever their tenant doc changes.

## What's simplified / still needs work before real users

Be honest with yourself about these before calling it "done":

- **Manager Reports tab** is a placeholder. Build real aggregation (Firestore aggregate queries, or export to BigQuery) once you have real collections data to report on.
- **Manager bar chart / stats grid** from the simulator was not ported — Overview currently just shows a tenant count and a "Run Billing" button. Worth rebuilding once you know what stats managers actually check daily.
- **Frontend polish**: partial-payment progress bars, receipt detail views, and some of the simulator's finer visual states weren't hand-ported. Core flows work; some screens are plainer than the simulator's.
- **Invite link domain**: `whatsapp.js` and `app.js` build invite links against `window.location.origin` / a placeholder domain — once you have a real hosting domain, double-check these match.
- **M-Pesa callback security**: Safaricom doesn't sign callbacks the way Twilio does. The code validates by matching `CheckoutRequestID` against a transaction you created, but for real production hardening, consider an IP allowlist (Cloud Armor / API Gateway) restricting `mpesaCallback` to Safaricom's IP ranges.
- **No self-serve manager signup** — by design, matching your spec ("Managers... controlled by custom claims"). Use `scripts/bootstrap.js` to create your first estate + manager.

## Deployment steps (exact order)

### 1. Firebase project setup
```powershell
npm install -g firebase-tools
firebase login
cd firebase
firebase use --add    # select/create your project, alias it "production"
```

### 2. Enable services in Firebase Console
- Authentication → Sign-in method → enable **Phone**
- Authentication → Settings → Authorized domains → add your real hosting domain once you have one
- Firestore Database → create in production mode
- Cloud Functions and Hosting are enabled automatically on first deploy

### 3. Install dependencies
```powershell
cd functions
npm install
cd ..
```

### 4. Set your real secrets
```powershell
firebase functions:secrets:set MPESA_CONSUMER_KEY
firebase functions:secrets:set MPESA_CONSUMER_SECRET
firebase functions:secrets:set MPESA_SHORTCODE
firebase functions:secrets:set MPESA_PASSKEY
firebase functions:secrets:set MPESA_CALLBACK_URL
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_FROM
```
- `MPESA_CALLBACK_URL` — you won't know this until after your first `functions` deploy. Deploy once, copy the `mpesaCallback` URL from the deploy output, then run this secret command with that URL.
- Get M-Pesa values from https://developer.safaricom.co.ke (create a Daraja app first).
- Get Twilio values from your Twilio Console, after enabling WhatsApp (sandbox for testing, or an approved sender for production).

### 5. Update the frontend Firebase config
Open `public/app.js` and replace the `FIREBASE_CONFIG` object (near the top) with your real values from Firebase Console → Project Settings → General → Your apps → Web app.

### 6. Deploy rules and functions
```powershell
firebase deploy --only firestore:rules,functions
```
Copy the `mpesaCallback` function URL from the output, then:
```powershell
firebase functions:secrets:set MPESA_CALLBACK_URL
```
paste that URL when prompted, and redeploy functions once more so it picks up the new secret:
```powershell
firebase deploy --only functions
```

### 7. Set your Twilio WhatsApp webhook
In Twilio Console → your WhatsApp sender → "When a message comes in", paste your deployed `whatsappWebhook` function URL.

### 8. Bootstrap your first estate + manager
```powershell
cd ../scripts
npm install
```
Download a service account key (Firebase Console → Project Settings → Service Accounts → Generate new private key) and save it as `scripts/serviceAccountKey.json`. Edit the `ESTATE`, `UNITS`, and `MANAGER` constants at the top of `bootstrap.js` to match your real estate, then:
```powershell
node bootstrap.js
```

### 9. Deploy the frontend
```powershell
cd ../firebase
firebase deploy --only hosting
```

### 10. Deploy everything together (for future updates)
```powershell
firebase deploy
```

## Testing before real residents join

1. Log in as your bootstrap manager phone number → confirm you land on the Manager Dashboard.
2. Log in as a new phone number → register a house from the House Entry screen → confirm you become household owner.
3. From Profile, generate the invite link → open it from a second phone number/incognito session → confirm the second user joins the same house instead of registering it fresh.
4. Trigger a bill via "Run Billing" on the manager dashboard, then pay it from the tenant side — confirm the real M-Pesa STK prompt appears on your phone and the balance updates after you complete or cancel it.
5. Message your Twilio WhatsApp number from a real phone — walk through onboarding, bill view, and payment via chat.
6. Post an announcement as manager, confirm it shows up for the tenant.

## Known gaps to flag to yourself, not hide from

If you're demoing or handing this to investors/co-founders, be upfront that Reports and some dashboard polish are intentionally deferred — the payment/billing/household/WhatsApp core (the actual hard, must-be-correct part) is real and working; the reporting layer is not.

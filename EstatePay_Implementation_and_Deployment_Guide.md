# EstatePay Implementation and Deployment Guide

## 1. What EstatePay Must Do

EstatePay should support:

- Resident registration and login.
- First household account registration by house number.
- Household invite links for adding more people to an already registered house.
- Household billing, where bills belong to the household unit.
- M-Pesa STK Push payment initiation.
- M-Pesa callback confirmation.
- Payment history and balances.
- WhatsApp onboarding and account access.
- Estate manager dashboard.
- Announcements and resident discussions.
- Firebase backend deployment.
- Frontend hosting deployment.

## 2. Local Project Structure

Current project files:

- `index.html` - main simulator page.
- `style.css` - frontend styling.
- `app.js` - frontend simulator logic.
- `firebase/firebase.json` - Firebase project configuration.
- `firebase/firestore.rules` - Firestore security rules.
- `firebase/functions/index.js` - Cloud Functions entry point.
- `firebase/functions/*` - backend functions for auth, billing, payments, WhatsApp, and forum.

## 3. Install Required Tools

Install Node.js 20.

Install Firebase CLI:

```powershell
npm install -g firebase-tools
```

Login to Firebase:

```powershell
firebase login
```

Confirm Firebase CLI works:

```powershell
firebase --version
```

## 4. Install Project Dependencies

From the project root:

```powershell
cd firebase
npm install
```

Install Cloud Functions dependencies:

```powershell
cd functions
npm install
```

Return to the Firebase folder:

```powershell
cd ..
```

## 5. Create Or Select Firebase Project

Create a Firebase project in the Firebase Console, then connect the local project:

```powershell
firebase use --add
```

Select your Firebase project.

Use an alias such as:

```text
production
```

## 6. Enable Firebase Services

In Firebase Console, enable:

- Firestore Database
- Authentication
- Cloud Functions
- Firebase Hosting

Recommended authentication providers:

- Phone Authentication for production resident login.
- Email/password for estate managers if needed.

## 7. Firestore Data Model

Create these main collections:

```text
estates
tenants
bills
transactions
forum_announcements
forum_discussions
```

Each estate should have a `units` subcollection:

```text
estates/{estateId}/units/{unitId}
```

Example estate:

```json
{
  "name": "Kilimani Heights",
  "location": "Kilimani, Nairobi",
  "adminPhoneNumbers": ["+254787654321"],
  "billingDay": 5,
  "createdAt": "server timestamp"
}
```

Example unit:

```json
{
  "houseNumber": "A-10",
  "block": "A",
  "monthlyRate": 3500,
  "occupied": true,
  "currentTenantPhone": "+254712345678",
  "householdOwnerPhone": "+254712345678",
  "inviteToken": "secure-random-token"
}
```

Example tenant:

```json
{
  "uid": "firebase-auth-uid",
  "fullName": "John Doe",
  "estateId": "estate-1",
  "unitId": "unit-1-1",
  "role": "resident",
  "verified": true,
  "createdAt": "server timestamp",
  "lastActiveAt": "server timestamp"
}
```

## 8. Household Registration Rules

Use this household logic:

1. If a house number is not registered, the first resident can register it.
2. The first resident becomes `householdOwnerPhone`.
3. The system creates an `inviteToken`.
4. Any later resident joining that house must use the invite link.
5. Direct joining by house number should be blocked once the house exists.
6. Only `householdOwnerPhone` can send or regenerate the invite link.

Invite link format:

```text
https://your-domain.com/?householdInvite=secure-random-token
```

For production, invite token creation and redemption should happen inside Cloud Functions, not directly from the frontend.

## 9. Backend Functions Needed For Production

Keep the existing functions:

- `resolveIdentity`
- `onTenantWrite`
- `whatsappWebhook`
- `initiateStkPush`
- `mpesaCallback`
- `generateMonthlyBills`
- `createAnnouncement`
- `createDiscussionPost`
- `createDiscussionReply`

Add or implement these production functions:

- `registerHousehold`
- `generateHouseholdInvite`
- `redeemHouseholdInvite`

Recommended behavior:

- `registerHousehold` creates the unit and tenant link.
- `generateHouseholdInvite` checks that the caller is the household owner.
- `redeemHouseholdInvite` validates the token and links the new tenant to the existing unit.

## 10. Firestore Security Rules

Deploy the included rules:

```powershell
firebase deploy --only firestore:rules
```

Important security principle:

- Tenants, bills, and transactions should not be directly writable by the client.
- Sensitive writes should go through Cloud Functions.
- Managers and committee users should be controlled by custom claims.

## 11. Configure M-Pesa Daraja

Create a Safaricom Daraja app.

Collect:

- Consumer key
- Consumer secret
- Business shortcode
- Passkey
- Callback URL

Your callback URL should point to the deployed `mpesaCallback` Cloud Function.

Set these as Firebase secrets or environment config.

Example:

```powershell
firebase functions:secrets:set MPESA_CONSUMER_KEY
firebase functions:secrets:set MPESA_CONSUMER_SECRET
firebase functions:secrets:set MPESA_SHORTCODE
firebase functions:secrets:set MPESA_PASSKEY
```

Update the M-Pesa function code to read from secrets before production deployment.

## 12. Configure Twilio WhatsApp

Create or use a Twilio account.

Enable WhatsApp Sandbox or production WhatsApp sender.

Set the webhook URL to:

```text
https://<region>-<project-id>.cloudfunctions.net/whatsappWebhook
```

Configure Twilio credentials as Firebase secrets:

```powershell
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_FROM
```

## 13. Run Locally With Firebase Emulators

From the `firebase` folder:

```powershell
npm run serve
```

Test:

- Firestore rules.
- Cloud Functions.
- Billing generation.
- M-Pesa initiation mock.
- WhatsApp webhook mock.

## 14. Test The Frontend Locally

Open:

```text
index.html
```

Manual flow:

1. Click `Get Started`.
2. Login or register a resident.
3. Register a new house number.
4. Go to Profile.
5. Click `Send Household Link`.
6. Login/register as another resident.
7. Paste the household invite link.
8. Confirm the new resident joins the same household.
9. Confirm direct entry into an already registered house is blocked.
10. Test payment flow and history.

## 15. Deploy Cloud Functions

From the `firebase` folder:

```powershell
firebase deploy --only functions
```

If deploying everything backend-related:

```powershell
firebase deploy --only firestore:rules,functions
```

## 16. Deploy Frontend To Firebase Hosting

Create a hosting folder:

```text
firebase/public
```

Copy these files into `firebase/public`:

- `index.html`
- `app.js`
- `style.css`

Update `firebase/firebase.json` to include hosting:

```json
{
  "hosting": {
    "public": "public",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ]
  },
  "firestore": {
    "rules": "firestore.rules"
  },
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "ignore": [
        "node_modules",
        ".git",
        "firebase-debug.log",
        "firestore-debug.log"
      ]
    }
  ]
}
```

Deploy hosting:

```powershell
firebase deploy --only hosting
```

Deploy all:

```powershell
firebase deploy
```

## 17. Production Readiness Checklist

Before going live, confirm:

- Firebase Authentication is enabled.
- Firestore rules are deployed.
- Cloud Functions are deployed.
- M-Pesa credentials are production credentials.
- M-Pesa callback URL is registered.
- Twilio WhatsApp webhook is live.
- Household invite tokens are generated server-side.
- Invite tokens are random, unique, and revocable.
- Bills are generated per household unit.
- Partial payments correctly update bill balance.
- Payment callbacks cannot be spoofed.
- Managers have proper custom claims.
- Residents cannot edit bills or transactions directly.
- Frontend uses production Firebase config.
- Hosting domain is connected.
- HTTPS is active.

## 18. Recommended Production Improvements

Add these before real users:

- Expiring invite links.
- Regenerate invite link button.
- Revoke invite link button.
- Household member removal by owner or manager.
- Audit logs for invite use.
- SMS or WhatsApp share action for invite links.
- Admin approval option for new households.
- M-Pesa callback signature validation.
- Error monitoring.
- Backups for Firestore.
- Role management panel for admins.

## 19. Final Deployment Command Sequence

Use this order:

```powershell
cd firebase
npm install
cd functions
npm install
cd ..
firebase login
firebase use --add
firebase deploy --only firestore:rules
firebase deploy --only functions
firebase deploy --only hosting
```

Or deploy everything together:

```powershell
cd firebase
firebase deploy
```

## 20. Final User Acceptance Test

Run this complete test:

1. Register House A-10 as first user.
2. Confirm first user becomes household owner.
3. Confirm Profile shows `Send Household Link`.
4. Copy/send invite link.
5. Register second user.
6. Try joining A-10 by house number only.
7. Confirm the app blocks direct joining.
8. Paste invite link.
9. Confirm second user joins A-10.
10. Generate monthly bill.
11. Pay partial amount.
12. Confirm balance reduces.
13. Pay remaining amount.
14. Confirm bill status becomes paid.
15. Confirm transaction appears in history.
16. Confirm manager dashboard shows correct tenant/payment status.


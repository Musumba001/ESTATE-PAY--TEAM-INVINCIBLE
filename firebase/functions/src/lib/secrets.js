/**
 * Central definition of all Firebase Secrets used across the backend.
 * Set these with:
 *   firebase functions:secrets:set MPESA_CONSUMER_KEY
 *   firebase functions:secrets:set MPESA_CONSUMER_SECRET
 *   firebase functions:secrets:set MPESA_SHORTCODE
 *   firebase functions:secrets:set MPESA_PASSKEY
 *   firebase functions:secrets:set MPESA_CALLBACK_URL
 *   firebase functions:secrets:set TWILIO_ACCOUNT_SID
 *   firebase functions:secrets:set TWILIO_AUTH_TOKEN
 *   firebase functions:secrets:set TWILIO_WHATSAPP_FROM
 *
 * Import the exact secrets a function needs and pass them into that
 * function's `secrets: [...]` option — do not attach every secret to every
 * function, since each attached secret adds a small amount of cold-start
 * overhead.
 */

const { defineSecret } = require("firebase-functions/params");

const MPESA_CONSUMER_KEY = defineSecret("MPESA_CONSUMER_KEY");
const MPESA_CONSUMER_SECRET = defineSecret("MPESA_CONSUMER_SECRET");
const MPESA_SHORTCODE = defineSecret("MPESA_SHORTCODE");
const MPESA_PASSKEY = defineSecret("MPESA_PASSKEY");
const MPESA_CALLBACK_URL = defineSecret("MPESA_CALLBACK_URL");

const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_WHATSAPP_FROM = defineSecret("TWILIO_WHATSAPP_FROM");

module.exports = {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
};

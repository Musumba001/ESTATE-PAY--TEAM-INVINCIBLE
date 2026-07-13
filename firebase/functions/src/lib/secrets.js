/**
 * Central definition of all Firebase Secrets used across the backend.
 * Set these with:
 *   firebase functions:secrets:set MPESA_CONSUMER_KEY
 *   firebase functions:secrets:set MPESA_CONSUMER_SECRET
 *   firebase functions:secrets:set MPESA_SHORTCODE
 *   firebase functions:secrets:set MPESA_PASSKEY
 *   firebase functions:secrets:set MPESA_CALLBACK_URL
 *   firebase functions:secrets:set META_WA_ACCESS_TOKEN
 *   firebase functions:secrets:set META_WA_PHONE_NUMBER_ID
 *   firebase functions:secrets:set META_WA_VERIFY_TOKEN
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

// Meta WhatsApp Cloud API — replaces previous Twilio secrets
const META_WA_ACCESS_TOKEN = defineSecret("META_WA_ACCESS_TOKEN");
const META_WA_PHONE_NUMBER_ID = defineSecret("META_WA_PHONE_NUMBER_ID");
const META_WA_VERIFY_TOKEN = defineSecret("META_WA_VERIFY_TOKEN");

module.exports = {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  META_WA_ACCESS_TOKEN,
  META_WA_PHONE_NUMBER_ID,
  META_WA_VERIFY_TOKEN,
};

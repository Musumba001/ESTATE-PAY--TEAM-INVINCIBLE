/**
 * Twilio WhatsApp integration.
 * Docs: https://www.twilio.com/docs/whatsapp
 */

const twilio = require("twilio");

function getClient(accountSid, authToken) {
  return twilio(accountSid, authToken);
}

/**
 * Sends a WhatsApp message via Twilio.
 * @param {object} opts
 * @param {string} opts.accountSid
 * @param {string} opts.authToken
 * @param {string} opts.from - e.g. "whatsapp:+14155238886"
 * @param {string} opts.to - E.164 phone, will be prefixed "whatsapp:"
 * @param {string} opts.body
 */
async function sendWhatsAppMessage({ accountSid, authToken, from, to, body }) {
  const client = getClient(accountSid, authToken);
  const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromAddr = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
  return client.messages.create({ from: fromAddr, to: toAddr, body });
}

/**
 * Validates that an inbound webhook request actually came from Twilio.
 * Twilio signs requests with X-Twilio-Signature using your Auth Token.
 * @param {string} authToken
 * @param {string} signature - value of the X-Twilio-Signature header
 * @param {string} url - the full URL Twilio called (must match exactly, including query string)
 * @param {object} params - the parsed form-encoded POST body
 */
function isValidTwilioRequest(authToken, signature, url, params) {
  return twilio.validateRequest(authToken, signature, url, params);
}

module.exports = { sendWhatsAppMessage, isValidTwilioRequest };

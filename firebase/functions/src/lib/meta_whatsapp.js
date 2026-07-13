/**
 * Meta WhatsApp Cloud API integration.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Replaces the previous Twilio-based WhatsApp integration.
 * Uses the Meta Graph API to send text messages via WhatsApp.
 * No additional npm packages needed — uses axios (already a dependency).
 *
 * Secrets required (set via `firebase functions:secrets:set`):
 *   META_WA_ACCESS_TOKEN      — Permanent System User token from Meta Business Manager
 *   META_WA_PHONE_NUMBER_ID   — Phone Number ID from Meta WhatsApp API Setup page
 *   META_WA_VERIFY_TOKEN      — Your custom token used to verify the webhook with Meta
 */

const axios = require("axios");

const GRAPH_API_VERSION = "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Sends a WhatsApp text message via the Meta Cloud API.
 *
 * @param {object} opts
 * @param {string} opts.accessToken  - META_WA_ACCESS_TOKEN secret value
 * @param {string} opts.phoneNumberId - META_WA_PHONE_NUMBER_ID secret value
 * @param {string} opts.to           - Recipient phone in E.164 format (e.g. "+254712345678"), no "whatsapp:" prefix
 * @param {string} opts.body         - Message text (supports WhatsApp markdown: *bold*, _italic_)
 * @returns {Promise<object>}        - Parsed Meta API response
 */
async function sendWhatsAppMessage({ accessToken, phoneNumberId, to, body }) {
  // Normalise: strip any "whatsapp:" prefix that may have been passed in
  const recipient = to.replace(/^whatsapp:/i, "").trim();

  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  const response = await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

/**
 * Verifies a Meta webhook challenge.
 *
 * Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge
 * when you first register (or update) a webhook. Respond with hub.challenge
 * if the tokens match; otherwise reject.
 *
 * @param {object} query            - req.query from the incoming GET request
 * @param {string} verifyToken      - META_WA_VERIFY_TOKEN secret value
 * @returns {{ ok: boolean, challenge: string|null }}
 */
function verifyWebhook(query, verifyToken) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return { ok: true, challenge };
  }
  return { ok: false, challenge: null };
}

/**
 * Extracts inbound messages from a Meta webhook POST payload.
 *
 * Meta wraps messages in a nested structure. This function returns a flat
 * array of { phone, body } objects so the caller doesn't need to know
 * the shape of the envelope.
 *
 * @param {object} payload - req.body from the incoming POST webhook
 * @returns {Array<{ phone: string, body: string, messageId: string }>}
 */
function extractInboundMessages(payload) {
  const messages = [];

  try {
    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const inbound = value.messages || [];
        for (const msg of inbound) {
          // We only handle text messages for the state machine
          if (msg.type === "text") {
            messages.push({
              phone: `+${msg.from}`,          // Meta sends without leading +
              body: msg.text?.body || "",
              messageId: msg.id,
            });
          }
        }
      }
    }
  } catch (err) {
    // Return empty rather than crashing — malformed payloads should be ignored
  }

  return messages;
}

module.exports = { sendWhatsAppMessage, verifyWebhook, extractInboundMessages };

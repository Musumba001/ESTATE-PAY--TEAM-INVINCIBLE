/**
 * receipts.js — Receipts & Notification Delivery Utility
 *
 * Formats payment receipts and sends WhatsApp alerts via the
 * Meta WhatsApp Cloud API (replaces previous Twilio integration).
 *
 * Environment variables used at runtime:
 *   META_WA_ACCESS_TOKEN    — set via Firebase Secret Manager
 *   META_WA_PHONE_NUMBER_ID — set via Firebase Secret Manager
 *
 * Falls back to console logging in the local emulator when secrets
 * are not configured.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

const db = admin.firestore();

const GRAPH_API_VERSION = "v19.0";

/**
 * Sends a WhatsApp text message via the Meta Cloud API.
 * Uses process.env because this file is outside the main secrets binding
 * flow — the caller (payments.js) should ensure the env is populated,
 * or this falls back gracefully to a console log.
 *
 * @param {string} to   - E.164 phone number (e.g. "+254712345678")
 * @param {string} body - Message text
 */
async function sendMetaWhatsApp(to, body) {
  const accessToken = process.env.META_WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    // Emulator / secrets not configured — log to console instead
    functions.logger.warn(
      "META_WA_ACCESS_TOKEN or META_WA_PHONE_NUMBER_ID not set. " +
      "WhatsApp receipt printed to console instead."
    );
    console.log(`[Meta WhatsApp Simulate to ${to}]:\n${body}`);
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/^whatsapp:/i, "").trim(),
      type: "text",
      text: { preview_url: false, body },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * generateReceiptAndNotify
 * Dispatches async messages to tenants after a successful M-Pesa payment.
 *
 * @param {object} transaction  - { tenantPhone, amount, billId, channel }
 * @param {string} receiptNumber - M-Pesa receipt/confirmation code
 */
async function generateReceiptAndNotify(transaction, receiptNumber) {
  const { tenantPhone, amount, billId, channel } = transaction;

  // 1. Fetch invoice info
  const billSnap = await db.collection("bills").doc(billId).get();
  const bill = billSnap.exists ? billSnap.data() : { period: "Monthly bill" };

  // 2. Fetch tenant profile to verify push settings / WhatsApp session state
  const tenantSnap = await db.collection("tenants").doc(tenantPhone).get();
  const tenant = tenantSnap.exists ? tenantSnap.data() : null;

  // 3. Compose receipt message
  const msgText =
    `*EstatePay Payment Receipt* ✅\n\n` +
    `Receipt ID: *${receiptNumber}*\n` +
    `Unit: *${bill.unitId || "N/A"}*\n` +
    `Period: *${bill.period}*\n` +
    `Paid Amount: *KES ${amount.toLocaleString()}*\n` +
    `Status: *PAID (M-Pesa STK)*\n` +
    `Date: *${new Date().toLocaleString("en-KE")}*\n\n` +
    `Thank you for your payment. Keep this as a reference record.`;

  functions.logger.log(`Dispatching payment receipt to ${tenantPhone} via WhatsApp.`);

  // 4. Send WhatsApp receipt via Meta Cloud API
  try {
    await sendMetaWhatsApp(tenantPhone, msgText);
    functions.logger.log(`WhatsApp receipt sent to: ${tenantPhone}`);
  } catch (err) {
    functions.logger.error("Failed to send WhatsApp receipt via Meta API:", err?.response?.data || err);
  }

  // 5. Send Mobile App Push notification (if app user has FCM token)
  if (tenant && tenant.fcmToken) {
    try {
      const payload = {
        notification: {
          title: "Payment Confirmed! 🎉",
          body: `KES ${amount.toLocaleString()} received for unit ${tenant.unitId}.`,
        },
        data: {
          billId,
          receiptNumber,
        },
      };
      await admin.messaging().sendToDevice(tenant.fcmToken, payload);
      functions.logger.log(`FCM push notification sent to UID: ${tenant.uid}`);
    } catch (fcmErr) {
      functions.logger.error("Failed to send mobile push notification:", fcmErr);
    }
  }

  return { success: true };
}

module.exports = {
  generateReceiptAndNotify,
};

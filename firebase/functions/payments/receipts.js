/**
 * receipts.js Receipts & Notification Delivery Utility
 * Formats receipts and sends SMS / WhatsApp alerts via Twilio Messaging API.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const twilio = require("twilio");

const db = admin.firestore();

// Twilio Client setup (using environment credentials)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886"; // Twilio Sandbox WhatsApp number
let twilioClient = null;

if (accountSid && authToken) {
  twilioClient = twilio(accountSid, authToken);
}

/**
 * generateReceiptAndNotify
 * Dispatches async messages to tenants post successful billing payment transaction
 */
async function generateReceiptAndNotify(transaction, receiptNumber) {
  const { tenantPhone, amount, billId, channel } = transaction;

  // 1. Fetch invoice info
  const billSnap = await db.collection("bills").doc(billId).get();
  const bill = billSnap.exists ? billSnap.data() : { period: "Monthly bill" };

  // 2. Fetch tenant profile to verify push settings / WhatsApp session state
  const tenantSnap = await db.collection("tenants").doc(tenantPhone).get();
  const tenant = tenantSnap.exists ? tenantSnap.data() : null;

  // 3. Compose receipt text message
  const msgText = `*EstatePay Payment Receipt*\n\n` +
                  `Receipt ID: *${receiptNumber}*\n` +
                  `Unit: *${bill.unitId || 'N/A'}*\n` +
                  `Period: *${bill.period}*\n` +
                  `Paid Amount: *KES ${amount.toLocaleString()}*\n` +
                  `Status: *PAID (M-Pesa STK)*\n` +
                  `Date: *${new Date().toLocaleString()}*\n\n` +
                  `Thank you for your payment. Keep this as a reference record.`;

  functions.logger.log(`Dispatching payment notification to ${tenantPhone} via WhatsApp.`);

  // 4. Send Twilio WhatsApp message if credentials are set
  if (twilioClient) {
    try {
      await twilioClient.messages.create({
        from: whatsappFrom,
        to: `whatsapp:${tenantPhone}`,
        body: msgText
      });
      functions.logger.log(`WhatsApp receipt message sent successfully via Twilio to: ${tenantPhone}`);
    } catch (twilioErr) {
      functions.logger.error("Failed to send WhatsApp message through Twilio API:", twilioErr);
    }
  } else {
    functions.logger.warn("Twilio API credentials not configured. WhatsApp receipt printed to console logs instead.");
    // In emulator mode we log it to standard console
    console.log(`[Twilio WhatsApp Simulate to ${tenantPhone}]:\n${msgText}`);
  }

  // 5. Send Mobile App Push notification (if app user has token)
  if (tenant && tenant.fcmToken) {
    try {
      const payload = {
        notification: {
          title: "Payment Confirmed!",
          body: `KES ${amount.toLocaleString()} received for unit ${tenant.unitId}.`
        },
        data: {
          billId,
          receiptNumber
        }
      };
      await admin.messaging().sendToDevice(tenant.fcmToken, payload);
      functions.logger.log(`FCM push notification sent successfully to UID: ${tenant.uid}`);
    } catch (fcmErr) {
      functions.logger.error("Failed to send mobile push notification:", fcmErr);
    }
  }

  return { success: true };
}

module.exports = {
  generateReceiptAndNotify
};

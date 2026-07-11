/**
 * whatsappWebhook HTTPS Webhook
 * Twilio integrations for receiving WhatsApp messages.
 * Maps messages to user profiles, executes state machine, and replies with TwiML.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { MessagingResponse } = require("twilio").twiml;
const { handleTransition, STATES } = require("./stateMachine");
const { renderEstateMenu } = require("./menus");
const { normalizePhone } = require("../shared/phone");

const db = admin.firestore();

exports.whatsappWebhook = functions.https.onRequest(async (req, res) => {
  // Validate request method (Twilio sends POST)
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const from = normalizePhone(req.body.From); // "whatsapp:+254712345678" -> "+254712345678"
  const body = (req.body.Body || "").trim();
  const twiml = new MessagingResponse();

  try {
    const tenantRef = db.collection("tenants").doc(from);
    const tenantSnap = await tenantRef.get();

    // 1. Check if user profile is already created
    if (!tenantSnap.exists) {
      // Unknown number -> Initiate onboarding session
      const initialSession = {
        state: STATES.ONBOARDING_ESTATE,
        data: {}
      };
      
      await tenantRef.set({
        uid: `wa-${Date.now()}`,
        fullName: `WhatsApp Tenant (${from.slice(-4)})`,
        whatsappSessionState: initialSession,
        verified: false,
        role: "resident",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Render introductory estate selection menu
      const estateMenu = await renderEstateMenu();
      twiml.message(`👋 Welcome to EstatePay!\n\n${estateMenu}`);
      return respond(res, twiml);
    }

    const tenant = tenantSnap.data();
    const session = tenant.whatsappSessionState || { state: STATES.IDLE, data: {} };

    // 2. Delegate transition to the state machine
    const { reply, nextState } = await handleTransition(session, body, tenant, from);

    // 3. Save updated session state
    await tenantRef.update({
      whatsappSessionState: nextState,
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Send response message back to user via TwiML XML
    twiml.message(reply);
    respond(res, twiml);

  } catch (error) {
    functions.logger.error("Error handling WhatsApp webhook request:", error);
    twiml.message("⚠️ An internal error occurred. Please try again later or reply with '0' to restart.");
    respond(res, twiml);
  }
});

// Sends TwiML response back to Twilio with proper Content-Type
function respond(res, twiml) {
  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
}

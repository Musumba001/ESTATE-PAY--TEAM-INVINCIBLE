/**
 * WhatsApp bot — real Twilio webhook + Firestore-backed state machine.
 *
 * Twilio calls whatsappWebhook (a public onRequest endpoint) for every
 * inbound WhatsApp message. We validate the request signature, load or
 * create session state for the sender's phone number, run one state
 * transition, persist the new state, and send a reply via the Twilio API.
 *
 * Session state lives in two places:
 *  - whatsapp_sessions/{phone}  — used BEFORE a tenant record exists
 *    (name collection, house registration/invite redemption).
 *  - tenants/{phone}.whatsappSessionState — used once the user is a
 *    verified tenant (mirrors the simulator's design).
 */

const { onRequest, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { db, FieldValue, normalizePhone, getTenant, getUnit } = require("./lib/firestoreHelpers");
const twilioLib = require("./lib/twilio");
const secrets = require("./lib/secrets");
const householdLib = require("./lib/household");
const { initiateStkPushInternal } = require("./payments");

const STATES = {
  ONBOARDING_NAME: "ONBOARDING_NAME",
  ONBOARDING_HOUSEHOLD_CHOICE: "ONBOARDING_HOUSEHOLD_CHOICE",
  ONBOARDING_ESTATE: "ONBOARDING_ESTATE",
  ONBOARDING_UNIT: "ONBOARDING_UNIT",
  MAIN_MENU: "MAIN_MENU",
  VIEW_BILL: "VIEW_BILL",
  ACCOUNT_DETAILS: "ACCOUNT_DETAILS",
  AWAITING_PAYMENT_AMOUNT: "AWAITING_PAYMENT_AMOUNT",
  FORUM_MENU: "FORUM_MENU",
  FORUM_AWAITING_POST: "FORUM_AWAITING_POST",
};

const MAIN_MENU_TEXT =
  "*EstatePay Main Menu*\n" +
  "1. View Bill\n" +
  "2. Pay Bill\n" +
  "3. Account Details\n" +
  "4. Estate Forum\n" +
  "5. Household Invite Link\n\n" +
  "Reply with a number, or *menu* anytime to return here.";

async function getSession(phone) {
  const snap = await db().collection("whatsapp_sessions").doc(phone).get();
  return snap.exists ? snap.data() : { state: null, data: {} };
}

async function setSession(phone, state, data = {}) {
  await db().collection("whatsapp_sessions").doc(phone).set(
    { state, data, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function setTenantSession(phone, state, data = {}) {
  await db().collection("tenants").doc(phone).update({
    whatsappSessionState: { state, data },
    lastActiveAt: FieldValue.serverTimestamp(),
  });
}

/** Main state-machine transition. Returns the reply text to send back. */
async function handleTransition(phone, body) {
  const text = (body || "").trim();
  const lower = text.toLowerCase();
  const tenant = await getTenant(phone);

  // Global reset shortcut, but only for already-onboarded tenants.
  if (tenant && (lower === "menu" || lower === "0")) {
    await setTenantSession(phone, STATES.MAIN_MENU);
    return MAIN_MENU_TEXT;
  }

  // -----------------------------------------------------------------
  // Not yet onboarded — run the name/household collection flow.
  // -----------------------------------------------------------------
  if (!tenant) {
    const session = await getSession(phone);

    if (!session.state) {
      await setSession(phone, STATES.ONBOARDING_NAME);
      return "👋 Welcome to *EstatePay*! Let's get you set up.\n\nWhat's your full name?";
    }

    if (session.state === STATES.ONBOARDING_NAME) {
      if (!text) return "Please reply with your full name.";
      await setSession(phone, STATES.ONBOARDING_HOUSEHOLD_CHOICE, { fullName: text });
      return (
        `Thanks, ${text}! Do you have a *household invite link* from your household owner?\n\n` +
        "If yes, paste the invite link or token now.\nIf you're the first person from your house to join, reply *NEW*."
      );
    }

    if (session.state === STATES.ONBOARDING_HOUSEHOLD_CHOICE) {
      if (lower === "new") {
        await setSession(phone, STATES.ONBOARDING_ESTATE, session.data);
        return "What is the name of your estate?";
      }
      // Treat anything else as an invite token/link.
      const token = extractInviteToken(text);
      try {
        await householdLib.redeemHouseholdInvite({ token, phone, fullName: session.data.fullName });
        await db().collection("whatsapp_sessions").doc(phone).delete();
        return `✅ You've joined your household successfully!\n\n${MAIN_MENU_TEXT}`;
      } catch (err) {
        return `That invite link didn't work (${err.message}). Please paste it again, or reply *NEW* to register a new house.`;
      }
    }

    if (session.state === STATES.ONBOARDING_ESTATE) {
      if (!text) return "Please reply with your estate name.";
      const estatesSnap = await db().collection("estates")
        .where("name", "==", text).limit(1).get();
      if (estatesSnap.empty) {
        return `We couldn't find an estate named "${text}". Please check the spelling and try again.`;
      }
      await setSession(phone, STATES.ONBOARDING_UNIT, { ...session.data, estateId: estatesSnap.docs[0].id, estateName: text });
      return "What is your house number? (e.g. A-10)";
    }

    if (session.state === STATES.ONBOARDING_UNIT) {
      if (!text) return "Please reply with your house number.";
      try {
        const result = await householdLib.registerHousehold({
          estateId: session.data.estateId,
          houseNumber: text,
          phone,
          fullName: session.data.fullName,
        });
        await db().collection("whatsapp_sessions").doc(phone).delete();
        const inviteLink = `https://your-domain.com/?householdInvite=${result.inviteToken}`;
        return (
          `✅ House ${text} registered! You are the household owner.\n\n` +
          `Share this invite link with other household members:\n${inviteLink}\n\n${MAIN_MENU_TEXT}`
        );
      } catch (err) {
        return `${err.message}\n\nIf this house is already registered, ask the household owner for the invite link instead.`;
      }
    }

    // Fallback
    await setSession(phone, STATES.ONBOARDING_NAME);
    return "Let's start again — what's your full name?";
  }

  // -----------------------------------------------------------------
  // Already onboarded tenant — main menu + submenus.
  // -----------------------------------------------------------------
  const sessionState = tenant.whatsappSessionState?.state || STATES.MAIN_MENU;
  const sessionData = tenant.whatsappSessionState?.data || {};

  if (sessionState === STATES.MAIN_MENU || !Object.values(STATES).includes(sessionState)) {
    switch (text) {
      case "1": {
        await setTenantSession(phone, STATES.VIEW_BILL);
        return renderBillSummary(tenant, phone);
      }
      case "2": {
        await setTenantSession(phone, STATES.AWAITING_PAYMENT_AMOUNT);
        const bill = await getActiveBill(phone);
        if (!bill) return `You have no outstanding bill. \n\n${MAIN_MENU_TEXT}`;
        return `Your outstanding balance is *KES ${bill.balance.toLocaleString()}*.\nReply with an amount to pay, or *full* to pay the full balance.`;
      }
      case "3": {
        await setTenantSession(phone, STATES.ACCOUNT_DETAILS);
        return await renderAccountDetails(tenant);
      }
      case "4": {
        await setTenantSession(phone, STATES.FORUM_MENU);
        return "*Estate Forum*\n1. View latest announcements\n2. Post a discussion topic\n\nReply *menu* to go back.";
      }
      case "5": {
        const unit = await getUnit(tenant.estateId, tenant.unitId);
        if (unit.householdOwnerPhone !== phone) {
          return `Only the household owner can share the invite link.\n\n${MAIN_MENU_TEXT}`;
        }
        const link = `https://your-domain.com/?householdInvite=${unit.inviteToken}`;
        return `Share this link with household members:\n${link}\n\n${MAIN_MENU_TEXT}`;
      }
      default:
        return MAIN_MENU_TEXT;
    }
  }

  if (sessionState === STATES.VIEW_BILL) {
    await setTenantSession(phone, STATES.MAIN_MENU);
    return MAIN_MENU_TEXT;
  }

  if (sessionState === STATES.AWAITING_PAYMENT_AMOUNT) {
    const bill = await getActiveBill(phone);
    if (!bill) {
      await setTenantSession(phone, STATES.MAIN_MENU);
      return `You have no outstanding bill.\n\n${MAIN_MENU_TEXT}`;
    }
    const amount = lower === "full" ? bill.balance : Number(text.replace(/[^0-9.]/g, ""));
    if (!amount || amount <= 0 || amount > bill.balance) {
      return `Please reply with a valid amount up to KES ${bill.balance.toLocaleString()}, or *full*.`;
    }

    try {
      await initiateStkPushInternal({ billId: bill.id, phone, payAmount: amount, channel: "whatsapp" });
      await setTenantSession(phone, STATES.MAIN_MENU);
      return `📲 Check your phone — an M-Pesa PIN prompt for *KES ${amount.toLocaleString()}* has been sent.\n\n${MAIN_MENU_TEXT}`;
    } catch (err) {
      await setTenantSession(phone, STATES.MAIN_MENU);
      return `Sorry, we couldn't start the payment (${err.message}). Please try again from the menu.`;
    }
  }

  if (sessionState === STATES.ACCOUNT_DETAILS) {
    await setTenantSession(phone, STATES.MAIN_MENU);
    return MAIN_MENU_TEXT;
  }

  if (sessionState === STATES.FORUM_MENU) {
    if (text === "1") {
      await setTenantSession(phone, STATES.MAIN_MENU);
      return await renderAnnouncements(tenant.estateId);
    }
    if (text === "2") {
      await setTenantSession(phone, STATES.FORUM_AWAITING_POST);
      return "What would you like to post? Reply with your message (it will be posted under your name).";
    }
    return "Reply 1 to view announcements, 2 to post a discussion topic, or *menu* to go back.";
  }

  if (sessionState === STATES.FORUM_AWAITING_POST) {
    if (!text) return "Please type a message to post.";
    await db().collection("forum_discussions").add({
      estateId: tenant.estateId,
      authorPhone: phone,
      title: text.slice(0, 60),
      body: text,
      createdAt: FieldValue.serverTimestamp(),
    });
    await setTenantSession(phone, STATES.MAIN_MENU);
    return `✅ Posted to the estate forum.\n\n${MAIN_MENU_TEXT}`;
  }

  // Fallback
  await setTenantSession(phone, STATES.MAIN_MENU);
  return MAIN_MENU_TEXT;
}

function extractInviteToken(value) {
  const match = value.match(/householdInvite=([^&\s]+)/);
  return match ? match[1] : value.trim();
}

async function getActiveBill(phone) {
  const snap = await db().collection("bills")
    .where("tenantPhone", "==", phone)
    .where("status", "in", ["pending", "overdue"])
    .limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function renderBillSummary(tenant, phone) {
  const bill = await getActiveBill(phone);
  if (!bill) return `You have no outstanding bill. All paid up! ✅\n\nReply *menu* to go back.`;
  return (
    `*Bill Summary — ${bill.period}*\n` +
    `Amount: KES ${bill.amount.toLocaleString()}\n` +
    `Paid: KES ${(bill.amountPaid || 0).toLocaleString()}\n` +
    `Balance: KES ${bill.balance.toLocaleString()}\n` +
    `Due: ${bill.dueDate?.toDate ? bill.dueDate.toDate().toDateString() : ""}\n\n` +
    `Reply *menu* to go back.`
  );
}

async function renderAccountDetails(tenant) {
  const unit = await getUnit(tenant.estateId, tenant.unitId);
  return (
    `*Account Details*\n` +
    `Name: ${tenant.fullName}\n` +
    `House: ${unit?.houseNumber || "—"}\n` +
    `Household owner: ${unit?.householdOwnerPhone === tenant.uid ? "You" : unit?.householdOwnerPhone || "—"}\n\n` +
    `Reply *menu* to go back.`
  );
}

async function renderAnnouncements(estateId) {
  const snap = await db().collection("forum_announcements")
    .where("estateId", "==", estateId)
    .orderBy("createdAt", "desc").limit(3).get();
  if (snap.empty) return "No announcements yet.\n\nReply *menu* to go back.";
  const lines = snap.docs.map((d) => `📌 *${d.data().title}*\n${d.data().body}`);
  return lines.join("\n\n") + "\n\nReply *menu* to go back.";
}

/**
 * whatsappWebhook — public HTTPS endpoint configured as the Twilio
 * "When a message comes in" webhook URL.
 */
const whatsappWebhook = onRequest(
  { secrets: [secrets.TWILIO_ACCOUNT_SID, secrets.TWILIO_AUTH_TOKEN, secrets.TWILIO_WHATSAPP_FROM] },
  async (req, res) => {
    try {
      const signature = req.headers["x-twilio-signature"];
      const fullUrl = `https://${req.hostname}${req.originalUrl}`;
      const validSignature = twilioLib.isValidTwilioRequest(
        secrets.TWILIO_AUTH_TOKEN.value(),
        signature,
        fullUrl,
        req.body
      );

      if (!validSignature) {
        logger.warn("whatsappWebhook: invalid Twilio signature, rejecting request.");
        res.status(403).send("Forbidden");
        return;
      }

      const fromRaw = req.body.From || ""; // "whatsapp:+2547XXXXXXXX"
      const phone = normalizePhone(fromRaw.replace("whatsapp:", ""));
      const body = req.body.Body || "";

      const replyText = await handleTransition(phone, body);

      await twilioLib.sendWhatsAppMessage({
        accountSid: secrets.TWILIO_ACCOUNT_SID.value(),
        authToken: secrets.TWILIO_AUTH_TOKEN.value(),
        from: secrets.TWILIO_WHATSAPP_FROM.value(),
        to: phone,
        body: replyText,
      });

      // Respond to Twilio's webhook with empty TwiML (we already sent the
      // reply via the REST API above, so no <Message> needed here).
      res.set("Content-Type", "text/xml");
      res.status(200).send("<Response></Response>");
    } catch (err) {
      logger.error("whatsappWebhook error:", err);
      res.status(200).send("<Response></Response>");
    }
  }
);

module.exports = { whatsappWebhook };

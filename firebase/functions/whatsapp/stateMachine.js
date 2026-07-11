/**
 * WhatsApp Chat Session State Machine Transition Controller.
 * Parses user input, changes session state, and queries database resources.
 */
const admin = require("firebase-admin");
const { 
  renderMainMenu, 
  renderUnitMenu, 
  renderBillSummary, 
  renderForumMenu, 
  renderAnnouncements 
} = require("./menus");
const { initiateStkPush } = require("../payments/initiateStkPush");
const { createDiscussionPost } = require("../forum/createDiscussionPost");

const db = admin.firestore();

const STATES = {
  IDLE: "IDLE",
  ONBOARDING_ESTATE: "ONBOARDING_ESTATE",
  ONBOARDING_UNIT: "ONBOARDING_UNIT",
  MAIN_MENU: "MAIN_MENU",
  VIEW_BILL: "VIEW_BILL",
  AWAITING_PAYMENT_CONFIRM: "AWAITING_PAYMENT_CONFIRM",
  FORUM_MENU: "FORUM_MENU",
  FORUM_AWAITING_POST: "FORUM_AWAITING_POST"
};

async function handleTransition(session, input, tenant, phone) {
  // Global Reset command
  if (input.toLowerCase() === "restart" || input === "0") {
    return {
      reply: renderMainMenu(),
      nextState: { state: STATES.MAIN_MENU, data: {} }
    };
  }

  switch (session.state) {
    
    // ---------------- STATE: ONBOARDING_ESTATE ----------------
    case STATES.ONBOARDING_ESTATE: {
      const estate = await matchEstateFromInput(input);
      if (!estate) {
        return {
          reply: "⚠️ Selection not recognized. Please reply with a valid number from the list.",
          nextState: session
        };
      }
      return {
        reply: await renderUnitMenu(estate.id),
        nextState: { state: STATES.ONBOARDING_UNIT, data: { estateId: estate.id } }
      };
    }

    // ---------------- STATE: ONBOARDING_UNIT ----------------
    case STATES.ONBOARDING_UNIT: {
      const unit = await matchUnitFromInput(session.data.estateId, input);
      if (!unit) {
        return {
          reply: "⚠️ Selection not recognized. Please reply with a valid number from the list.",
          nextState: session
        };
      }

      // Complete registration: Update tenant record in database
      await db.collection("tenants").doc(phone).update({
        estateId: session.data.estateId,
        unitId: unit.id,
        verified: true, // Auto-verify in MVP (can be gated by admin approval rules)
        fullName: tenant.fullName || `WhatsApp Tenant (${phone.slice(-4)})`
      });

      return {
        reply: `🎉 Congratulations! Registration successful.\nLinked to: *${(await db.collection("estates").doc(session.data.estateId).get()).data().name}*, House: *${unit.houseNumber}*\n\n${renderMainMenu()}`,
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
    }

    // ---------------- STATE: MAIN_MENU / IDLE ----------------
    case STATES.IDLE:
    case STATES.MAIN_MENU: {
      if (input === "1") {
        return {
          reply: await renderBillSummary(phone),
          nextState: { state: STATES.VIEW_BILL, data: {} }
        };
      }
      if (input === "2") {
        return {
          reply: renderForumMenu(),
          nextState: { state: STATES.FORUM_MENU, data: {} }
        };
      }
      return {
        reply: `⚠️ Menu option not recognized.\n\n${renderMainMenu()}`,
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
    }

    // ---------------- STATE: VIEW_BILL ----------------
    case STATES.VIEW_BILL: {
      if (input === "1") {
        // Find unpaid bill ID for the phone number
        const billsSnap = await db.collection("bills")
          .where("tenantPhone", "==", phone)
          .where("status", "==", "pending")
          .limit(1)
          .get();

        if (billsSnap.empty) {
          return {
            reply: `No outstanding bills found. Reply *0* to return.`,
            nextState: { state: STATES.MAIN_MENU, data: {} }
          };
        }

        const billId = billsSnap.docs[0].id;
        const billAmount = billsSnap.docs[0].data().amount;

        try {
          // Trigger the internal M-Pesa STK Push integration helper (Mock client / internal logic)
          // Inside Cloud Functions, we call the initiation function context directly
          // We pass context mock variables to simulate functions scope
          await triggerStkPushInternal(billId, phone, billAmount, "whatsapp");
          
          return {
            reply: `📱 M-Pesa STK Push has been sent to your handset. Please enter your PIN on your phone to complete payment. We will notify you here immediately once payment completes.\n\n_Reply 0 to cancel and return to menu._`,
            nextState: { state: STATES.AWAITING_PAYMENT_CONFIRM, data: { billId } }
          };
        } catch (err) {
          return {
            reply: `❌ Failed to trigger STK Push: ${err.message}. Reply *0* to restart.`,
            nextState: { state: STATES.MAIN_MENU, data: {} }
          };
        }
      }
      return {
        reply: renderMainMenu(),
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
    }

    // ---------------- STATE: AWAITING_PAYMENT_CONFIRM ----------------
    case STATES.AWAITING_PAYMENT_CONFIRM: {
      // User typed something while waiting. Remind them.
      return {
        reply: `🕒 We are waiting for M-Pesa network confirmation of your payment. We will notify you when completed.\n\n_Reply 0 to return to Main Menu._`,
        nextState: session
      };
    }

    // ---------------- STATE: FORUM_MENU ----------------
    case STATES.FORUM_MENU: {
      if (input === "1") {
        return {
          reply: await renderAnnouncements(tenant.estateId),
          nextState: { state: STATES.MAIN_MENU, data: {} }
        };
      }
      if (input === "2") {
        return {
          reply: `✏️ *Post to Discussions*:\n\nType your message below and send it. It will be posted directly to your estate discussion board.`,
          nextState: { state: STATES.FORUM_AWAITING_POST, data: {} }
        };
      }
      return {
        reply: renderMainMenu(),
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
    }

    // ---------------- STATE: FORUM_AWAITING_POST ----------------
    case STATES.FORUM_AWAITING_POST: {
      if (input.length < 5) {
        return {
          reply: "⚠️ Message too short. Please send a message with more than 5 characters or reply *0* to cancel.",
          nextState: session
        };
      }

      // Create discussion document inside Firestore
      const threadRef = db.collection("forum_discussions").doc();
      await threadRef.set({
        estateId: tenant.estateId,
        authorPhone: phone,
        title: `WhatsApp Post (${new Date().toLocaleDateString()})`,
        body: input,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        reply: `✅ Posted to estate discussions successfully!\n\n${renderMainMenu()}`,
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
    }

    default:
      return {
        reply: renderMainMenu(),
        nextState: { state: STATES.MAIN_MENU, data: {} }
      };
  }
}

// Helper: Match index number back to estate doc
async function matchEstateFromInput(input) {
  const estatesSnap = await db.collection("estates").orderBy("createdAt", "asc").get();
  const selectIdx = parseInt(input) - 1;
  if (isNaN(selectIdx) || selectIdx < 0 || selectIdx >= estatesSnap.size) {
    return null;
  }
  const matchDoc = estatesSnap.docs[selectIdx];
  return { id: matchDoc.id, ...matchDoc.data() };
}

// Helper: Match index number back to unit doc
async function matchUnitFromInput(estateId, input) {
  const unitsSnap = await db.collection("estates").doc(estateId).collection("units").get();
  const selectIdx = parseInt(input) - 1;
  if (isNaN(selectIdx) || selectIdx < 0 || selectIdx >= unitsSnap.size) {
    return null;
  }
  const matchDoc = unitsSnap.docs[selectIdx];
  return { id: matchDoc.id, ...matchDoc.data() };
}

// Helper: Trigger STK Push transaction entry inside database directly (called during state flow)
async function triggerStkPushInternal(billId, phone, amount, channel) {
  const checkoutRequestId = "ws_CO_" + Date.now();
  const txnRef = db.collection("transactions").doc();
  await txnRef.set({
    billId,
    tenantPhone: phone,
    amount,
    mpesaCheckoutRequestId: checkoutRequestId,
    status: "initiated",
    channel,
    initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: null
  });
  
  // Safaricom process STK push logic is mocked here
  // In production, we would trigger request to processrequest endpoint
}

module.exports = {
  STATES,
  handleTransition
};

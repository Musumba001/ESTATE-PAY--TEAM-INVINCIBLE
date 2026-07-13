/**
 * EstatePay Interactive System Simulator Engine
 * Simulated Backend: Firestore, Cloud Functions, M-Pesa API, Twilio Webhook
 *
 * This whole file runs entirely in the browser — there is no real server,
 * database, or M-Pesa/WhatsApp connection anywhere here. Every "API call"
 * (functions prefixed apiXxx) and every "webhook" is just a plain JS
 * function that mutates the `db` object below and logs what it did to the
 * System Event Console, so the app behaves and looks like the real thing
 * without needing any backend infrastructure to run.
 */

// ==========================================================================
// 1. Live Database State (Simulated Firestore)
// ==========================================================================
// `db` is the "live" simulated Firestore: the mutable object every
// apiXxx()/waXxx() function reads from and writes to as the demo runs
// (new bills, payments, chat state, forum posts, etc. all land here).
// It starts out as a deep copy of SEED_DATA (see resetDatabase() below) and
// then drifts away from it as the user interacts with the app — that's why
// there are two objects instead of one.
let db = {
  estates: {},
  tenants: {},
  bills: {},
  transactions: {},
  forum_announcements: {},
  forum_discussions: {},
  replies: {} // Keyed by threadId for subcollection replies simulation
};

// `SEED_DATA` is the fixed, original starting dataset (two demo estates,
// their units/houses, two pre-registered tenants, one bill each, etc.).
// resetDatabase() clones this into `db` on load and whenever the user hits
// "Restart Demo", so the demo always starts from the same known state.
// Note: `units` lives only in SEED_DATA (not in `db`) — newly registered
// houses get appended directly onto SEED_DATA.units at runtime instead.
const SEED_DATA = {
  estates: {
    "estate-1": { name: "Kilimani Heights", location: "Kilimani, Nairobi", adminPhoneNumbers: ["+254787654321"], billingDay: 5, createdAt: new Date("2026-01-01T08:00:00Z") },
    "estate-2": { name: "Runda Greens", location: "Runda, Nairobi", adminPhoneNumbers: ["+254700001111"], billingDay: 1, createdAt: new Date("2026-01-10T08:00:00Z") }
  },
  units: {
    "estate-1": {
      "unit-1-1": { houseNumber: "A-10", block: "A", monthlyRate: 3500, occupied: true, currentTenantPhone: "+254712345678", householdOwnerPhone: "+254712345678", inviteToken: "invite-a10-john" },
      "unit-1-2": { houseNumber: "A-12", block: "A", monthlyRate: 4000, occupied: true, currentTenantPhone: "+254787654321", householdOwnerPhone: "+254787654321", inviteToken: "invite-a12-jane" },
      "unit-1-3": { houseNumber: "B-01", block: "B", monthlyRate: 3200, occupied: false, currentTenantPhone: null, householdOwnerPhone: null, inviteToken: null }
    },
    "estate-2": {
      "unit-2-1": { houseNumber: "R-01", block: "Main", monthlyRate: 15000, occupied: true, currentTenantPhone: "+254700001111", householdOwnerPhone: "+254700001111", inviteToken: "invite-r01-admin" },
      "unit-2-2": { houseNumber: "R-02", block: "Main", monthlyRate: 18000, occupied: false, currentTenantPhone: null, householdOwnerPhone: null, inviteToken: null }
    }
  },
  tenants: {
    "+254712345678": { uid: "auth-user-1", fullName: "John Doe", estateId: "estate-1", unitId: "unit-1-1", role: "resident", verified: true, whatsappSessionState: { state: "MAIN_MENU", data: {} }, createdAt: new Date("2026-02-15T09:00:00Z"), lastActiveAt: new Date() },
    "+254787654321": { uid: "auth-user-2", fullName: "Jane Smith", estateId: "estate-1", unitId: "unit-1-2", role: "committee", verified: true, whatsappSessionState: { state: "MAIN_MENU", data: {} }, createdAt: new Date("2026-02-20T10:00:00Z"), lastActiveAt: new Date() }
  },
  bills: {
    "bill-1": { tenantPhone: "+254712345678", estateId: "estate-1", unitId: "unit-1-1", period: "2026-07", amount: 3500, amountPaid: 0, balance: 3500, status: "pending", dueDate: new Date("2026-07-20T17:00:00Z"), generatedAt: new Date("2026-07-05T08:00:00Z"), paidTransactionId: null },
    "bill-2": { tenantPhone: "+254787654321", estateId: "estate-1", unitId: "unit-1-2", period: "2026-07", amount: 4000, amountPaid: 4000, balance: 0, status: "paid", dueDate: new Date("2026-07-20T17:00:00Z"), generatedAt: new Date("2026-07-05T08:00:00Z"), paidTransactionId: "txn-seed-1" }
  },
  transactions: {
    "txn-seed-1": { billId: "bill-2", tenantPhone: "+254787654321", amount: 4000, mpesaCheckoutRequestId: "ws_CO_06071415_abc", mpesaReceiptNumber: "QE67K8JHS", status: "success", channel: "app", initiatedAt: new Date("2026-07-05T12:00:00Z"), completedAt: new Date("2026-07-05T12:01:30Z") }
  },
  forum_announcements: {
    "ann-1": { estateId: "estate-1", authorPhone: "+254787654321", title: "Water Supply Interruption", body: "Dear residents, please note there will be a water maintenance shutdown on Tuesday from 9 AM to 4 PM. Kindly store sufficient water.", pinned: true, createdAt: new Date("2026-07-04T11:00:00Z") }
  },
  forum_discussions: {
    "disc-1": { estateId: "estate-1", authorPhone: "+254712345678", title: "Security light broken near Block A", body: "Hi, the security light near Block A has been flickering for a week and went out completely last night. Can we have it fixed?", createdAt: new Date("2026-07-03T14:00:00Z") }
  },
  replies: {
    "disc-1": {
      "rep-1": { authorPhone: "+254787654321", body: "Thanks for reporting, John. I have notified the estate electrician. He is scheduled to replace the bulb tomorrow morning.", createdAt: new Date("2026-07-03T15:30:00Z") }
    }
  }
};

// ==========================================================================
// 2. Active Session Management for Client Mockups
// ==========================================================================
let activePhone = "+254712345678"; // Simulated logged-in user in mobile app / whatsapp
let currentMobileTab = "home";     // active tab: "home" | "forum" | "profile"
let selectedThreadId = null;       // active discussion thread viewed inside mobile app
let activeDbCollection = "estates"; // active tab in DB viewer
let pendingMpesaCheckout = null;   // stores checkoutRequestId while waiting for PIN entry

// WhatsApp bot state definitions (matching Node.js code)
const WA_STATES = {
  IDLE: "IDLE",
  ONBOARDING_ESTATE: "ONBOARDING_ESTATE",
  ONBOARDING_UNIT: "ONBOARDING_UNIT",
  MAIN_MENU: "MAIN_MENU",
  VIEW_BILL: "VIEW_BILL",
  ACCOUNT_DETAILS: "ACCOUNT_DETAILS",
  AWAITING_PAYMENT_AMOUNT: "AWAITING_PAYMENT_AMOUNT",
  AWAITING_PAYMENT_CONFIRM: "AWAITING_PAYMENT_CONFIRM",
  FORUM_MENU: "FORUM_MENU",
  FORUM_AWAITING_POST: "FORUM_AWAITING_POST"
};

// Initialize DB with seed data
function resetDatabase() {
  db = JSON.parse(JSON.stringify(SEED_DATA));
  // Convert ISO string dates back to Date objects
  Object.keys(db).forEach(coll => {
    Object.keys(db[coll]).forEach(docId => {
      let doc = db[coll][docId];
      if (doc.createdAt) doc.createdAt = new Date(doc.createdAt);
      if (doc.lastActiveAt) doc.lastActiveAt = new Date(doc.lastActiveAt);
      if (doc.dueDate) doc.dueDate = new Date(doc.dueDate);
      if (doc.generatedAt) doc.generatedAt = new Date(doc.generatedAt);
      if (doc.initiatedAt) doc.initiatedAt = new Date(doc.initiatedAt);
      if (doc.completedAt) doc.completedAt = new Date(doc.completedAt);
    });
  });
  
  // also convert replies dates
  Object.keys(db.replies).forEach(threadId => {
    Object.keys(db.replies[threadId]).forEach(repId => {
      let rep = db.replies[threadId][repId];
      if (rep.createdAt) rep.createdAt = new Date(rep.createdAt);
    });
  });

  // Reset mobile screen state
  currentScreen = "splash";
  authRole = "tenant";
  authTab = "login";
  showPassword = false;
  showConfirmPassword = false;
  houseNumberInput = "";
  householdInviteInput = "";
  tenantActiveTab = "home";
  managerActiveTab = "overview";
  authEmail = "";
  authPhone = "";
  authFullName = "";
  authPassword = "";
  authConfirmPassword = "";
  householdEntryStep = "search";
  registerEstateName = "";
  payingBillId = null;
  paymentAmountInput = "";
  showSuccessToast = false;
  managerSearch = "";
  managerFilterStatus = "all";
  selectedTenant = null;
  noticeText = "";
  noticeTarget = "all";
  showNoticeSentToast = false;
  managerAnnouncementTitle = "";
  managerAnnouncementBody = "";
  showAnnouncementSentToast = false;

  logSystemEvent("DATABASE", "Firestore DB reset to default seed state.");
  renderDbViewer();
  renderMobileApp();
  initWhatsAppChat();
}

// Write system logs to center console
function logSystemEvent(category, message, details = null) {
  const container = document.getElementById("system-logs");
  const logDiv = document.createElement("div");
  logDiv.className = "log-entry";
  
  const timeStr = new Date().toLocaleTimeString();
  let tagClass = "system";
  if (category === "API") tagClass = "api";
  if (category === "DATABASE") tagClass = "db";
  
  logDiv.innerHTML = `
    <div class="log-meta">
      <span class="log-time">${timeStr}</span>
      <span class="log-tag ${tagClass}">${category}</span>
    </div>
    <div class="log-content">${message} ${details ? `<br><small style="color:var(--text-muted); font-size:10px;">${JSON.stringify(details)}</small>` : ''}</div>
  `;
  container.appendChild(logDiv);
  container.scrollTop = container.scrollHeight;
}

// ==========================================================================
// 3. Simulated Firebase SDK & Cloud Functions
// ==========================================================================

/**
 * resolveIdentity() Cloud Function
 * Checks if phone number is onboarded
 */
async function apiResolveIdentity(phoneNumber) {
  logSystemEvent("API", `Callable triggered: resolveIdentity(${phoneNumber})`);
  
  // O(1) document lookup
  const tenant = db.tenants[phoneNumber];
  
  if (tenant) {
    logSystemEvent("DATABASE", `Read: tenants/${phoneNumber} (Found)`);
    return { exists: true, tenant };
  } else {
    logSystemEvent("DATABASE", `Read: tenants/${phoneNumber} (Not Found)`);
    return { exists: false };
  }
}

/**
 * initiateStkPush() Cloud Function
 * Triggers Safaricom Daraja STK prompt, writes transaction doc
 * @param {string} billId
 * @param {string} channel
 * @param {number} [payAmount]  Optional custom amount; defaults to full bill amount
 */
async function apiInitiateStkPush(billId, channel, payAmount) {
  logSystemEvent("API", `Callable triggered: initiateStkPush({ billId: "${billId}", channel: "${channel}", amount: ${payAmount || 'full'} })`);
  
  const bill = db.bills[billId];
  if (!bill) {
    throw new Error("Bill not found.");
  }
  if (bill.status === "paid") {
    throw new Error("Bill is already paid.");
  }

  // Determine the actual amount to charge — custom or full balance
  const currentBalance = bill.balance !== undefined ? bill.balance : bill.amount;
  const chargeAmount = (payAmount && payAmount > 0) ? payAmount : Math.max(currentBalance, bill.amount);
  
  // Make API request to Safaricom Daraja STK Push (Mock)
  logSystemEvent("API", `Daraja Client: POST https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest`);
  
  const checkoutRequestId = "ws_CO_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4);
  
  // Server-side write to transactions collection
  const txnId = "txn-" + Date.now();
  db.transactions[txnId] = {
    billId,
    tenantPhone: bill.tenantPhone,
    amount: chargeAmount,
    mpesaCheckoutRequestId: checkoutRequestId,
    status: "initiated",
    channel: channel,
    initiatedAt: new Date(),
    completedAt: null
  };
  
  logSystemEvent("DATABASE", `Write: transactions/${txnId}`, db.transactions[txnId]);
  renderDbViewer();

  // Return trigger for USSD Handset Simulator
  setTimeout(() => {
    triggerMpesaUSSD(checkoutRequestId, chargeAmount, bill.tenantPhone, billId);
  }, 1000);

  return { 
    success: true, 
    checkoutRequestId, 
    message: "STK Push sent. Enter M-Pesa PIN on your phone." 
  };
}

/**
 * mpesaCallback() HTTPS Webhook
 * Triggered by Safaricom Daraja once user enters PIN
 */
async function apiMpesaCallback(checkoutRequestId, pinEntered, success = true) {
  logSystemEvent("API", `HTTPS Webhook: mpesaCallback received for checkout ID "${checkoutRequestId}"`);
  
  // 1. Query transaction by checkout ID (simulate .where() filter)
  let matchingTxnId = null;
  Object.keys(db.transactions).forEach(id => {
    if (db.transactions[id].mpesaCheckoutRequestId === checkoutRequestId) {
      matchingTxnId = id;
    }
  });

  if (!matchingTxnId) {
    logSystemEvent("API", `Callback failed: No transaction found matching checkoutRequestId ${checkoutRequestId}`);
    return { status: "ignored" };
  }

  const transaction = db.transactions[matchingTxnId];
  
  // In this simulator any PIN works EXCEPT it must equal "1234" to succeed —
  // that's the one hard-coded "correct" PIN, standing in for real Daraja
  // PIN verification. Any other 4-digit PIN, or `success = false` (user
  // hit Cancel on the USSD dialog), falls through to the failure branch below.
  if (success && pinEntered === "1234") { // Mock PIN validation
    const receiptNum = "Q" + Math.random().toString(36).substr(2, 8).toUpperCase();
    
    // 2. Update transaction
    transaction.status = "success";
    transaction.mpesaReceiptNumber = receiptNum;
    transaction.completedAt = new Date();
    logSystemEvent("DATABASE", `Update: transactions/${matchingTxnId}`, { status: "success", mpesaReceiptNumber: receiptNum });

    // 3. Update bill — partial or full payment
    const bill = db.bills[transaction.billId];
    const prevBalance = bill.balance !== undefined ? bill.balance : bill.amount;
    const prevPaid   = bill.amountPaid || 0;
    const newPaid    = prevPaid + transaction.amount;
    const newBalance = prevBalance - transaction.amount;

    bill.amountPaid = newPaid;
    bill.balance    = newBalance;

    if (newBalance <= 0) {
      bill.status = "paid";
      bill.paidTransactionId = matchingTxnId;
      logSystemEvent("DATABASE", `Update: bills/${transaction.billId}`, { status: "paid", amountPaid: newPaid, balance: newBalance });
      logSystemEvent("SYSTEM", newBalance < 0 ? `Advance payment received. Household credit: KSh ${Math.abs(newBalance).toLocaleString()}. Receipt: ${receiptNum}` : `Bill fully settled. Receipt: ${receiptNum}`);
    } else {
      bill.status = "pending";
      logSystemEvent("DATABASE", `Update: bills/${transaction.billId}`, { status: "pending", amountPaid: newPaid, balance: newBalance });
      logSystemEvent("SYSTEM", `Payment of KSh ${transaction.amount.toLocaleString()} received. Balance remaining: KSh ${newBalance.toLocaleString()}. Receipt: ${receiptNum}`);
    }
    
    logSystemEvent("SYSTEM", `Payment successful. Digital receipt generated: ${receiptNum}`);

    // 4. Show success toast in mobile app if paying from app
    if (transaction.channel === "app") {
      payingBillId = null;
      showSuccessToast = true;
      successToastMessage = `✅ Payment Confirmed! Receipt: ${receiptNum}`;
      setTimeout(() => {
        showSuccessToast = false;
        renderMobileApp();
      }, 4000);
    }

    // 5. If transaction was from WhatsApp bot, notify user via WhatsApp API, update state
    const tenant = db.tenants[transaction.tenantPhone];
    if (tenant) {
      if (tenant.whatsappSessionState.state === WA_STATES.AWAITING_PAYMENT_CONFIRM) {
        tenant.whatsappSessionState = { state: WA_STATES.MAIN_MENU, data: {} };
        logSystemEvent("DATABASE", `Update: tenants/${transaction.tenantPhone}`, { whatsappSessionState: { state: "MAIN_MENU" } });
        
        // Push WhatsApp notification
        setTimeout(() => {
          const balMsg = newBalance > 0 ? `\nBalance Remaining: *KES ${newBalance.toLocaleString()}*` : "\nBill fully settled! ✅";
          sendWhatsAppSystemMessage(
            transaction.tenantPhone, 
            `*EstatePay Payment Confirmed!*\n\nReceipt: *${receiptNum}*\nAmount Paid: *KES ${transaction.amount.toLocaleString()}*\nBill Period: *${db.bills[transaction.billId].period}*${balMsg}\n\nThank you. Type *0* for Main Menu.`
          );
        }, 1500);
      }
    }
  } else {
    // Wrong PIN or the user cancelled the STK prompt — mark the transaction
    // failed and, if applicable, bounce the WhatsApp session back to the
    // main menu so they aren't stuck waiting forever.
    // Failed STK push
    transaction.status = "failed";
    transaction.completedAt = new Date();
    logSystemEvent("DATABASE", `Update: transactions/${matchingTxnId}`, { status: "failed" });
    logSystemEvent("SYSTEM", `Payment failed or user cancelled STK push.`);

    // If transaction was from WhatsApp, notify and return to main menu
    const tenant = db.tenants[transaction.tenantPhone];
    if (tenant && tenant.whatsappSessionState.state === WA_STATES.AWAITING_PAYMENT_CONFIRM) {
      tenant.whatsappSessionState = { state: WA_STATES.MAIN_MENU, data: {} };
      logSystemEvent("DATABASE", `Update: tenants/${transaction.tenantPhone}`, { whatsappSessionState: { state: "MAIN_MENU" } });
      
      setTimeout(() => {
        sendWhatsAppSystemMessage(
          transaction.tenantPhone, 
          `❌ *M-Pesa payment failed* or was cancelled. Reply *0* to return to the Main Menu.`
        );
      }, 1500);
    }
  }

  renderDbViewer();
  renderMobileApp();
}

/**
 * generateMonthlyBills() Scheduled Billing Function
 * Simulates monthly bill trigger
 */
function apiGenerateMonthlyBills() {
  logSystemEvent("API", `Scheduled Job: generateMonthlyBills() triggered manually via Admin panel`);
  
  const currentPeriod = "2026-08"; // simulating next month billing
  let billsCreated = 0;

  // Enforce server-side loop: Read estates, then units, then create one security bill per household unit
  Object.keys(db.estates).forEach(estateId => {
    const estate = db.estates[estateId];

    // Find units scoped to this estate (mimicking collection group sub-collection query)
    const estateUnits = SEED_DATA.units[estateId] || {};

    Object.keys(estateUnits).forEach(unitId => {
      const unit = estateUnits[unitId];

      if (unit.occupied) {
        const tenantPhone = unit.currentTenantPhone || null;

        // Check if a bill for this household and period already exists to avoid double billings
        let billExists = false;
        Object.keys(db.bills).forEach(bId => {
          const bill = db.bills[bId];
          if (bill.estateId === estateId && bill.unitId === unitId && bill.period === currentPeriod) {
            billExists = true;
          }
        });

        if (!billExists) {
          const newBillId = `bill-${Date.now()}-${billsCreated}`;
          db.bills[newBillId] = {
            tenantPhone,
            estateId,
            unitId,
            period: currentPeriod,
            amount: unit.monthlyRate,
            status: "pending",
            dueDate: new Date("2026-08-20T17:00:00Z"),
            generatedAt: new Date(),
            paidTransactionId: null
          };

          logSystemEvent("DATABASE", `Write: bills/${newBillId}`, db.bills[newBillId]);
          billsCreated++;
        }
      }
    });
  });

  logSystemEvent("SYSTEM", `Billing run completed. Generated ${billsCreated} new bills for Period: ${currentPeriod}`);
  renderDbViewer();
  renderMobileApp();
}

/**
 * createAnnouncement() Cloud Function
 * Server-side write with role claim verification
 */
async function apiCreateAnnouncement(authorPhone, title, body) {
  logSystemEvent("API", `Callable triggered: createAnnouncement({ title: "${title}" })`);
  
  // 1. Fetch author profile to verify authorization
  const author = db.tenants[authorPhone];
  if (!author || (author.role !== "committee" && author.role !== "admin")) {
    logSystemEvent("API", `Unauthorized: Phone ${authorPhone} has role "${author ? author.role : 'none'}". Write rejected.`);
    alert("Permission Denied: Write rejected by security rules (Requires Committee/Admin claims).");
    return;
  }

  const annId = `ann-${Date.now()}`;
  db.forum_announcements[annId] = {
    estateId: author.estateId,
    authorPhone: authorPhone,
    title: title,
    body: body,
    pinned: false,
    createdAt: new Date()
  };

  logSystemEvent("DATABASE", `Write: forum_announcements/${annId}`, db.forum_announcements[annId]);
  renderDbViewer();
  renderMobileApp();

  // Push announcement to all tenants of the estate via WhatsApp
  Object.keys(db.tenants).forEach(phone => {
    const t = db.tenants[phone];
    if (t.estateId === author.estateId && t.role !== "manager" && t.role !== "admin") {
      const msg = `📢 *NEW ESTATE ANNOUNCEMENT*\n\n*${title}*\n\n${body}\n\n_Issued by Estate Management_`;
      sendWhatsAppSystemMessage(phone, msg);
    }
  });
}

/**
 * createDiscussionPost()
 * Writes standard resident forum posts
 */
async function apiCreateDiscussionPost(authorPhone, title, body) {
  logSystemEvent("API", `Callable triggered: createDiscussionPost({ title: "${title}" })`);
  
  const author = db.tenants[authorPhone];
  if (!author || !author.verified) {
    alert("Permission Denied: Only verified residents can post.");
    return;
  }

  const threadId = `disc-${Date.now()}`;
  db.forum_discussions[threadId] = {
    estateId: author.estateId,
    authorPhone: authorPhone,
    title: title,
    body: body,
    createdAt: new Date()
  };

  logSystemEvent("DATABASE", `Write: forum_discussions/${threadId}`, db.forum_discussions[threadId]);
  renderDbViewer();
  renderMobileApp();
}

/**
 * createReply()
 * Adds reply to a discussion sub-collection
 */
async function apiCreateReply(threadId, authorPhone, body) {
  logSystemEvent("API", `Callable triggered: createReply({ threadId: "${threadId}" })`);
  
  const author = db.tenants[authorPhone];
  if (!author || !author.verified) {
    alert("Permission Denied: Only verified residents can reply.");
    return;
  }

  if (!db.replies[threadId]) {
    db.replies[threadId] = {};
  }

  const replyId = `rep-${Date.now()}`;
  db.replies[threadId][replyId] = {
    authorPhone: authorPhone,
    body: body,
    createdAt: new Date()
  };

  logSystemEvent("DATABASE", `Write: forum_discussions/${threadId}/replies/${replyId}`, db.replies[threadId][replyId]);
  renderDbViewer();
  renderMobileApp();
}


// ==========================================================================
// 4. WhatsApp State Machine Interface (Twilio Webhook Web Interface)
// ==========================================================================

// Twilio Delivery Webhook Simulator
async function sendWhatsAppUserMessage(body) {
  const from = activePhone;
  const normalizedText = body.trim();
  
  // Render user text bubble immediately
  appendWhatsAppBubble(normalizedText, "sent");

  logSystemEvent("API", `Inbound Twilio Webhook POST /whatsappWebhook`, { From: `whatsapp:${from}`, Body: normalizedText });
  
  // Load tenant document
  const tenant = db.tenants[from];
  let session = tenant ? tenant.whatsappSessionState : null;
  
  if (!tenant) {
    // Trigger onboarding since phone is not registered
    const defaultState = { state: WA_STATES.ONBOARDING_ESTATE, data: {} };
    db.tenants[from] = {
      whatsappSessionState: defaultState,
      verified: false,
      createdAt: new Date()
    };
    logSystemEvent("DATABASE", `Write: tenants/${from} (onboarding session)`, db.tenants[from]);
    session = defaultState;
  }

  // Run transition
  const { reply, nextState } = await waHandleTransition(session, normalizedText, db.tenants[from], from);
  
  // Save updated session state
  db.tenants[from].whatsappSessionState = nextState;
  db.tenants[from].lastActiveAt = new Date();
  logSystemEvent("DATABASE", `Update: tenants/${from}`, { whatsappSessionState: nextState });

  // Simulate server thinking delay, then reply
  setTimeout(() => {
    appendWhatsAppBubble(reply, "received");
    renderDbViewer();
  }, 800);
}

// Push system message from webhook asynchronously
function sendWhatsAppSystemMessage(phone, message) {
  logSystemEvent("API", `Outbound Twilio API SMS POST /Messages`, { To: `whatsapp:${phone}`, Body: message });
  if (phone === activePhone) {
    appendWhatsAppBubble(message, "received");
  }
}

// Webhook state transition tables (Matches architecture document state switch)
async function waHandleTransition(session, input, tenant, phone) {
  // Core state machine: one case per WA_STATES value. Each branch reads the
  // user's raw text `input`, decides what to reply, and returns the next
  // session state to persist onto the tenant's `whatsappSessionState` field.
  switch (session.state) {
    // Step 1 of onboarding: new phone number, ask which estate they live in.
    case WA_STATES.ONBOARDING_ESTATE: {
      const estateId = input === "1" ? "estate-1" : input === "2" ? "estate-2" : null;
      if (!estateId) {
        return {
          reply: "⚠️ Invalid option. Select your estate:\n1. Kilimani Heights\n2. Runda Greens",
          nextState: session
        };
      }
      const estate = db.estates[estateId];
      return {
        reply: await waRenderUnitMenu(estateId),
        nextState: { state: WA_STATES.ONBOARDING_UNIT, data: { estateId } }
      };
    }

    // Step 2 of onboarding: user picked an estate, now ask which house/unit.
    case WA_STATES.ONBOARDING_UNIT: {
      // Find units in current estate to validate selection
      const estateUnits = SEED_DATA.units[session.data.estateId] || {};
      const unitKeys = Object.keys(estateUnits);
      const selectedIndex = parseInt(input) - 1;
      
      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= unitKeys.length) {
        return {
          reply: `⚠️ Invalid house selection. Please select one of the units listed.`,
          nextState: session
        };
      }

      const selectedUnitId = unitKeys[selectedIndex];
      const unitDetails = estateUnits[selectedUnitId];

      // Mutate tenant record to verified, link estate/unit
      db.tenants[phone].estateId = session.data.estateId;
      db.tenants[phone].unitId = selectedUnitId;
      db.tenants[phone].verified = true;
      db.tenants[phone].fullName = tenant.fullName || `WhatsApp User (${phone.substr(-4)})`;
      db.tenants[phone].role = "resident";

      logSystemEvent("DATABASE", `Update: tenants/${phone}`, {
        estateId: session.data.estateId,
        unitId: selectedUnitId,
        verified: true,
        role: "resident"
      });

      return {
        reply: `🎉 Registration successful! You are linked to *${db.estates[session.data.estateId].name}*, Unit *${unitDetails.houseNumber}*.\n\n${waRenderMainMenu()}`,
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
    }

    // Fully onboarded user sitting at the main numbered menu (1-4).
    case WA_STATES.IDLE:
    case WA_STATES.MAIN_MENU: {
      if (input === "1") {
        return {
          reply: await waRenderBillSummary(phone),
          nextState: { state: WA_STATES.VIEW_BILL, data: {} }
        };
      }
      if (input === "2") {
        const pendingBill = getTenantHouseholdBill(phone);
        const pendingBillId = pendingBill?.id || null;

        if (!pendingBillId) {
          return {
            reply: `✅ You have no outstanding bills. Reply *0* for Main Menu.`,
            nextState: { state: WA_STATES.MAIN_MENU, data: {} }
          };
        }

        const bal = pendingBill.balance !== undefined ? pendingBill.balance : pendingBill.amount;
        return {
          reply: `💸 *Pay Bill*:\n\nOutstanding Balance: *KES ${bal.toLocaleString()}*\n\nPlease enter the amount you wish to pay (KES):`,
          nextState: { state: WA_STATES.AWAITING_PAYMENT_AMOUNT, data: { billId: pendingBillId, balance: bal } }
        };
      }
      if (input === "3") {
        return {
          reply: await waRenderPaymentHistory(phone),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      if (input === "4") {
        return {
          reply: await waRenderAccountDetails(phone),
          nextState: { state: WA_STATES.ACCOUNT_DETAILS, data: {} }
        };
      }
      return {
        reply: waRenderMainMenu(),
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
    }

    // User just viewed their bill summary; either start a payment or return to menu.
    case WA_STATES.VIEW_BILL: {
      if (input === "0") {
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      if (input === "1") {
        const pendingBill = getTenantHouseholdBill(phone);
        const pendingBillId = pendingBill?.id || null;

        if (!pendingBillId) {
          return {
            reply: `No outstanding bills found. Reply *0* for Main Menu.`,
            nextState: { state: WA_STATES.MAIN_MENU, data: {} }
          };
        }

        const bal = pendingBill.balance !== undefined ? pendingBill.balance : pendingBill.amount;
        return {
          reply: `💸 *Pay Bill*:\n\nOutstanding Balance: *KES ${bal.toLocaleString()}*\n\nPlease enter the amount you wish to pay (KES):`,
          nextState: { state: WA_STATES.AWAITING_PAYMENT_AMOUNT, data: { billId: pendingBillId, balance: bal } }
        };
      }
      return {
        reply: `${waRenderMainMenu()}\n\nReply *0* to return to Main Menu.`,
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
    }

    // User is viewing their account/profile details screen.
    case WA_STATES.ACCOUNT_DETAILS: {
      if (input === "0") {
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      return {
        reply: await waRenderAccountDetails(phone),
        nextState: session
      };
    }

    // Bot asked "how much do you want to pay?" — validate the number, then
    // fire the (simulated) M-Pesa STK push and move to the confirm-wait state.
    case WA_STATES.AWAITING_PAYMENT_AMOUNT: {
      if (input === "0") {
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }

      const amt = parseFloat(input);
      
      if (isNaN(amt) || amt <= 0) {
        return {
          reply: `⚠️ Invalid amount. Please enter a valid number greater than 0:`,
          nextState: session
        };
      }

      // Valid amount! Trigger STK Push
      apiInitiateStkPush(session.data.billId, "whatsapp", amt);

      return {
        reply: `📱 M-Pesa STK Push of *KES ${amt.toLocaleString()}* has been sent to your handset. Please enter your PIN to confirm. Awaiting confirmation...\n\n_Reply 0 to cancel and return to menu._`,
        nextState: { state: WA_STATES.AWAITING_PAYMENT_CONFIRM, data: { billId: session.data.billId, amount: amt } }
      };
    }

    // STK push has been sent to the (simulated) handset; we're polling/waiting
    // for the user to enter their M-Pesa PIN. The actual confirmation arrives
    // asynchronously via apiMpesaCallback(), not through this text input.
    case WA_STATES.AWAITING_PAYMENT_CONFIRM: {
      if (input === "0") {
        // User cancelled waiting
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      return {
        reply: `🕒 We are still waiting for M-Pesa network response. Enter *0* to return to Main Menu.`,
        nextState: session
      };
    }

    // Estate Forum sub-menu: view announcements or start composing a discussion post.
    case WA_STATES.FORUM_MENU: {
      if (input === "0") {
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      if (input === "1") {
        return {
          reply: await waRenderAnnouncements(tenant.estateId),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }
      if (input === "2") {
        return {
          reply: `✏️ *Post to Discussions*:\n\nType your message below and send it. It will be posted directly to your estate discussion board.`,
          nextState: { state: WA_STATES.FORUM_AWAITING_POST, data: {} }
        };
      }
      return {
        reply: waRenderMainMenu(),
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
    }

    // User was asked to type their discussion post; validate length, then publish it.
    case WA_STATES.FORUM_AWAITING_POST: {
      if (input.length < 5) {
        return {
          reply: `⚠️ Message too short. Please send a message with more than 5 characters or reply *0* to cancel.`,
          nextState: session
        };
      }
      if (input === "0") {
        return {
          reply: waRenderMainMenu(),
          nextState: { state: WA_STATES.MAIN_MENU, data: {} }
        };
      }

      await apiCreateDiscussionPost(phone, `WhatsApp Post (${new Date().toLocaleDateString()})`, input);
      
      return {
        reply: `✅ Posted to estate discussions successfully!\n\n${waRenderMainMenu()}`,
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
    }

    default:
      return {
        reply: waRenderMainMenu(),
        nextState: { state: WA_STATES.MAIN_MENU, data: {} }
      };
  }
}

// WhatsApp Text Render Layout Helpers
function waRenderMainMenu() {
  return `📋 *EstatePay Main Menu*:\n\n1. 💵 My Bill\n2. 💸 Pay Bill\n3. 📄 Payment History\n4. 🧾 Account Details\n\nReply with *1*, *2*, *3*, or *4* to select.\nReply *0* to return to this menu anytime.`;
}

// Builds the formatted payment-history text shown for WhatsApp menu option 3 ("Payment History").
async function waRenderPaymentHistory(phone) {
  let reply = `📄 *Payment History*:\n\n`;
  const txnList = getTenantPaymentHistory(phone);

  if (txnList.length === 0) {
    return `📄 *Payment History*:\n\nNo successful payments yet. Reply *0* to return to the Main Menu.`;
  }

  txnList.forEach(tx => {
    reply += `Receipt: *${tx.mpesaReceiptNumber || `TXN-${tx.id.substr(-4)}`}*\nAmount Paid: *KES ${tx.amount.toLocaleString()}*\nDate: *${new Date(tx.completedAt || tx.initiatedAt).toLocaleDateString()}*\n\n`;
  });

  if (count === 0) {
    reply += `No payment records found.`;
  }
  reply += `\n\nReply *0* to return to Main Menu.`;
  return reply;
}

// Renders the text for the Estate Forum sub-menu (announcements vs. post-a-discussion). Currently unused by the active state machine but kept for future forum-menu wiring.
function waRenderForumMenu() {
  return `💬 *Estate Forum*:\n\n1. 📢 View Announcements\n2. ✍️ Post to Discussion Board\n\nReply with *1* or *2*. Reply *0* to return to Main Menu.`;
}

// Renders a numbered list of house units for onboarding step 2, letting a new WhatsApp user pick their unit by number.
async function waRenderUnitMenu(estateId) {
  const units = SEED_DATA.units[estateId] || {};
  let listStr = `🏠 *Select Your House Unit* in ${db.estates[estateId].name}:\n\n`;
  let idx = 1;
  Object.keys(units).forEach(id => {
    listStr += `${idx}. Unit *${units[id].houseNumber}* (KES ${units[id].monthlyRate}/mo)\n`;
    idx++;
  });
  listStr += `\nReply with the item number (e.g. *1*) to confirm.`;
  return listStr;
}

// Renders a formatted summary of the tenant's profile (name, estate, house, role, outstanding balance) for WhatsApp option 4.
async function waRenderAccountDetails(phone) {
  const tenant = db.tenants[phone];
  const estate = tenant?.estateId ? db.estates[tenant.estateId] : null;
  const unit = tenant?.estateId && tenant?.unitId && SEED_DATA.units[tenant.estateId] ? SEED_DATA.units[tenant.estateId][tenant.unitId] : null;
  const householdBills = getTenantHouseholdBills(phone).filter(bill => bill.status !== "paid");
  const balance = householdBills.reduce((total, bill) => total + (bill.balance !== undefined ? bill.balance : bill.amount), 0);

  return `🏠 *Account Details*:\n\nName: *${tenant?.fullName || "N/A"}*\nPhone: *${phone}*\nEstate: *${estate?.name || "Not linked"}*\nHouse: *${unit?.houseNumber || "Not linked"}*\nRole: *${tenant?.role || "resident"}*\nVerified: *${tenant?.verified ? "Yes" : "No"}*\nHousehold Outstanding Balance: *KES ${balance.toLocaleString()}*\n\nReply *0* to return to Main Menu.`;
}

// Renders the outstanding-bill summary text for WhatsApp option 1, including balance, due date, and status.
async function waRenderBillSummary(phone) {
  let pendingBill = null;
  const householdBills = getTenantHouseholdBills(phone);
  householdBills.forEach(bill => {
    if (bill.status !== "paid") {
      pendingBill = bill;
    }
  });

  if (!pendingBill) {
    return `✅ *Your Bills*:\n\nYou have no outstanding bills at this time. All payments are up to date!\n\nReply *0* to return to Main Menu.`;
  }

  const currentBalance = pendingBill.balance !== undefined ? pendingBill.balance : pendingBill.amount;
  return `💵 *Outstanding Bill Summary*:\n\nPeriod: *${pendingBill.period}*\nTotal Bill: *KES ${pendingBill.amount.toLocaleString()}*\nAmount Paid: *KES ${(pendingBill.amountPaid || 0).toLocaleString()}*\nBalance Due: *KES ${currentBalance.toLocaleString()}*\nDue Date: *${new Date(pendingBill.dueDate).toLocaleDateString()}*\nStatus: *${pendingBill.status.toUpperCase()}*\n\nReply *1* to pay via M-Pesa STK push.\nReply *0* to return to Main Menu.`;
}

// Lists every posted announcement for a given estate as WhatsApp-formatted text (used by the forum menu).
async function waRenderAnnouncements(estateId) {
  let output = `📢 *Announcements for ${db.estates[estateId].name}*:\n\n`;
  let count = 0;
  
  Object.keys(db.forum_announcements).forEach(id => {
    const ann = db.forum_announcements[id];
    if (ann.estateId === estateId) {
      output += `${ann.pinned ? '📌 *[PINNED]* ' : ''}*${ann.title}*\n${ann.body}\n_Posted on ${new Date(ann.createdAt).toLocaleDateString()}_\n\n`;
      count++;
    }
  });

  if (count === 0) {
    output += `No announcements posted.`;
  }
  output += `\n\nReply *0* to return to Main Menu.`;
  return output;
}


// ==========================================================================
// 5. User Interface Rendering & Logic
// ==========================================================================

// ==========================================================================
// 5. User Interface Rendering & Logic (New Screen State-Machine Engine)
// ==========================================================================

// Screen States & Inputs
let currentScreen = "splash"; // "splash" | "auth" | "house-entry" | "tenant-dashboard" | "manager-dashboard"
let authRole = "tenant"; // "tenant" | "manager"
let authTab = "login"; // "login" | "register"
let showPassword = false;
let showConfirmPassword = false;
let houseNumberInput = "";
let householdInviteInput = "";
let tenantActiveTab = "home"; // "home" | "announcements" | "payments" | "history" | "profile"
let managerActiveTab = "overview"; // "overview" | "tenants" | "notices" | "reports"

// Forms inputs
let authEmail = "";
let authPhone = "";
let authFullName = "";
let authPassword = "";
let authConfirmPassword = "";

// House Entry details
let householdEntryStep = "search"; // "search" | "join" | "register"
let registerEstateName = "";

// Looks up a unit by its human-entered house number, optionally scoped to a single estate. Returns { estateId, unitId, unit } or null.
function findUnitByHouseNumber(houseNumber, estateScopeId = null) {
  const normalized = (houseNumber || "").trim().toLowerCase();
  if (!normalized) return null;

  const estateIds = estateScopeId ? [estateScopeId] : Object.keys(SEED_DATA.units);
  for (const estateId of estateIds) {
    if (!SEED_DATA.units[estateId]) continue;
    for (const unitId of Object.keys(SEED_DATA.units[estateId])) {
      const unit = SEED_DATA.units[estateId][unitId];
      if (unit.houseNumber.toLowerCase() === normalized) {
        return { estateId, unitId, unit };
      }
    }
  }

  return null;
}

// Looks up a unit by its household invite token (used when a new member joins via a shared invite link).
function findUnitByInviteToken(token) {
  const normalized = (token || "").trim();
  if (!normalized) return null;

  for (const estateId of Object.keys(SEED_DATA.units)) {
    for (const unitId of Object.keys(SEED_DATA.units[estateId])) {
      const unit = SEED_DATA.units[estateId][unitId];
      if (unit.inviteToken === normalized) {
        return { estateId, unitId, unit };
      }
    }
  }

  return null;
}

// Extracts the raw invite token from either a full pasted invite URL or a bare token string.
function extractInviteToken(value) {
  const raw = (value || "").trim();
  if (!raw) return "";

  try {
    const parsedUrl = new URL(raw, window.location.href);
    return parsedUrl.searchParams.get("householdInvite") || raw;
  } catch (error) {
    return raw;
  }
}

// Builds a unique invite-token string for a newly registered household unit.
function createHouseholdInviteToken(estateId, unitId) {
  return `invite-${estateId}-${unitId}-${Date.now()}`;
}

// Builds the full shareable invite URL (current origin + ?householdInvite=<token>) for a unit.
function getHouseholdInviteLink(unit) {
  if (!unit || !unit.inviteToken) return "";
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("householdInvite", unit.inviteToken);
  return url.toString();
}

// Resolves the estate/unit pair linked to the currently active (logged-in) tenant, or null if unlinked.
function getActiveTenantUnit() {
  const tenant = db.tenants[activePhone];
  if (!tenant || !tenant.estateId || !tenant.unitId) return null;
  const unit = SEED_DATA.units[tenant.estateId]?.[tenant.unitId];
  if (!unit) return null;
  return { estateId: tenant.estateId, unitId: tenant.unitId, unit };
}

// Syncs the houseNumberInput UI variable from a tenant's linked unit record (used right after login).
function setHouseNumberFromTenant(phone) {
  const tenant = db.tenants[phone];
  const unit = tenant ? SEED_DATA.units[tenant.estateId]?.[tenant.unitId] : null;
  houseNumberInput = unit ? unit.houseNumber : "";
}

// Handles a new household member joining an existing house via the owner's invite link: creates their tenant record and links them to the unit.
function joinHouseholdFromInvite(inviteValue) {
  const token = extractInviteToken(inviteValue);
  const match = findUnitByInviteToken(token);
  if (!match) {
    alert("Invalid or expired household invite link.");
    return false;
  }

  db.tenants[activePhone] = {
    uid: "auth-user-" + Date.now(),
    fullName: authFullName || "Resident Tenant",
    estateId: match.estateId,
    unitId: match.unitId,
    role: "resident",
    verified: true,
    whatsappSessionState: { state: "MAIN_MENU", data: {} },
    createdAt: new Date(),
    lastActiveAt: new Date()
  };

  match.unit.occupied = true;
  if (!match.unit.currentTenantPhone) {
    match.unit.currentTenantPhone = activePhone;
  }
  if (!match.unit.householdOwnerPhone) {
    match.unit.householdOwnerPhone = activePhone;
  }

  houseNumberInput = match.unit.houseNumber;
  householdInviteInput = "";
  logSystemEvent("DATABASE", `Write: tenants/${activePhone}`, db.tenants[activePhone]);
  logSystemEvent("SYSTEM", `Tenant joined household ${match.unit.houseNumber} using owner invite link: ${activePhone}`);
  return true;
}

// Tenant Dashboard details
let payingBillId = null;
let paymentAmountInput = ""; // custom amount the user types in the payment modal
let showSuccessToast = false;
let successToastMessage = "";

// Manager Dashboard details
let managerSearch = "";
let managerFilterStatus = "all"; // "all" | "paid" | "pending"
let selectedTenant = null; // tenant object
let noticeText = "";
let noticeTarget = "all"; // "all" | "pending" | tenantId
let showNoticeSentToast = false;
let managerAnnouncementTitle = "";
let managerAnnouncementBody = "";
let showAnnouncementSentToast = false;
let sentNoticesList = [
  { to: "Ngozi Okafor (A2)", message: "Your security fee is overdue. Please make payment immediately to avoid further action.", date: "Jul 1, 2026" },
  { to: "Chidi Eze (C1)", message: "Your security fee payment is overdue. Please contact the estate management office.", date: "Jul 2, 2026" }
];

const monthlyData = [
  { month: "Feb", collected: 9000 },
  { month: "Mar", collected: 7500 },
  { month: "Apr", collected: 9000 },
  { month: "May", collected: 6000 },
  { month: "Jun", collected: 7500 },
  { month: "Jul", collected: 4500 }
];

// Returns every bill document that belongs to a tenant's household (estate + unit).
function getTenantHouseholdBills(phone) {
  const tenant = db.tenants[phone];
  if (!tenant || !tenant.estateId || !tenant.unitId) return [];

  return Object.keys(db.bills)
    .map(bId => ({ id: bId, ...db.bills[bId] }))
    .filter(bill => bill.estateId === tenant.estateId && bill.unitId === tenant.unitId);
}

// Returns the most recently generated bill for a tenant's household (used as the "current" bill).
function getTenantHouseholdBill(phone) {
  const householdBills = getTenantHouseholdBills(phone);
  if (!householdBills.length) return null;

  householdBills.sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
  return householdBills[0];
}

// Returns successful payment transactions tied to a tenant/household, sorted newest first.
function getTenantPaymentHistory(phone) {
  const tenant = db.tenants[phone];
  if (!tenant) return [];

  const householdBillIds = new Set(getTenantHouseholdBills(phone).map(bill => bill.id));

  return Object.keys(db.transactions)
    .map(tId => ({ id: tId, ...db.transactions[tId] }))
    .filter(txn => txn.status === "success" && (txn.tenantPhone === phone || householdBillIds.has(txn.billId)))
    .sort((a, b) => new Date(b.completedAt || b.initiatedAt || 0) - new Date(a.completedAt || a.initiatedAt || 0));
}

// Computes the outstanding balance for a bill, falling back to the full bill amount if `balance` was never set.
function getBillBalance(bill) {
  if (!bill) return 0;
  return bill.balance !== undefined ? bill.balance : (bill.amount || 0) - (bill.amountPaid || 0);
}

// Derives a simple "pending" / "paid" status label from a bill's current balance.
function getBillStatus(bill) {
  return getBillBalance(bill) > 0 ? "pending" : "paid";
}

// Sums outstanding balances across every bill in a tenant's household (used for household-level totals).
function getHouseBalance(phone) {
  const bills = getTenantHouseholdBills(phone);
  return bills.reduce((total, bill) => total + getBillBalance(bill), 0);
}

// Maps a numeric balance to a color-coded UI label: green credit, blue zero-balance, red pending.
function getBalanceDisplay(balance) {
  if (balance < 0) return { label: `Credit KSh ${Math.abs(balance).toLocaleString()}`, color: "#10B981", status: "paid" };
  if (balance === 0) return { label: "KSh 0", color: "#60A5FA", status: "paid" };
  return { label: `KSh ${balance.toLocaleString()}`, color: "#EF4444", status: "pending" };
}

// Comparator used to naturally/numerically sort house-number strings (e.g. "A-2" before "A-10").
function sortHouseNumbers(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

// Helper to resolve or create simulated bill for tenant
function getActiveTenantBill() {
  const tenant = db.tenants[activePhone];
  if (!tenant) return null;

  let tenantBill = getTenantHouseholdBill(activePhone);

  // If no bill exists, let's create a simulated pending one for the household
  if (!tenantBill) {
    const unit = tenant.estateId && tenant.unitId && SEED_DATA.units[tenant.estateId]
      ? SEED_DATA.units[tenant.estateId][tenant.unitId]
      : null;
    const newBillId = `bill-${Date.now()}`;
    const defaultAmount = unit?.monthlyRate || 1500;
    db.bills[newBillId] = {
      tenantPhone: activePhone,
      estateId: tenant.estateId || "estate-1",
      unitId: tenant.unitId || "unit-1-1",
      period: "2026-07",
      amount: defaultAmount,
      amountPaid: 0,
      balance: defaultAmount,
      status: "pending",
      dueDate: new Date("2026-07-20T17:00:00Z"),
      generatedAt: new Date(),
      paidTransactionId: null
    };
    tenantBill = { id: newBillId, ...db.bills[newBillId] };
    logSystemEvent("DATABASE", `Write: bills/${newBillId} (Simulated security bill for dashboard)`, db.bills[newBillId]);
    renderDbViewer();
  }
  // Back-fill balance for older seed bills that don't have it
  if (tenantBill.balance === undefined) {
    tenantBill.balance = tenantBill.amount;
    tenantBill.amountPaid = 0;
    db.bills[tenantBill.id].balance = tenantBill.amount;
    db.bills[tenantBill.id].amountPaid = 0;
  }

  return tenantBill;
}

// Helper to resolve all registered household details
function getTenantList() {
  const list = [];

  Object.keys(SEED_DATA.units).forEach(estateId => {
    Object.keys(SEED_DATA.units[estateId]).forEach(unitId => {
      const unit = SEED_DATA.units[estateId][unitId];
      if (!unit.occupied || !unit.householdOwnerPhone) return;

      const ownerPhone = unit.householdOwnerPhone;
      const owner = db.tenants[ownerPhone];

      const householdBills = Object.keys(db.bills)
        .map(bId => ({ id: bId, ...db.bills[bId] }))
        .filter(bill => bill.estateId === estateId && bill.unitId === unitId)
        .sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
      const currentBill = householdBills[0] || null;
      const balance = currentBill ? getBillBalance(currentBill) : unit.monthlyRate;
      const balanceDisplay = getBalanceDisplay(balance);

      list.push({
        id: ownerPhone,
        name: owner?.fullName || `Registered by ${ownerPhone.substr(-4)}`,
        houseNo: unit.houseNumber,
        block: `Block ${unit.block || "Main"}`,
        phone: ownerPhone,
        security: balanceDisplay.status,
        balance,
        balanceLabel: balanceDisplay.label,
        balanceColor: balanceDisplay.color,
        bill: currentBill,
        estateId,
        unitId
      });
    });
  });

  return list.sort((a, b) => sortHouseNumbers(a.houseNo, b.houseNo));
}

// Render SVGBarchart
function renderManagerBarChart(data) {
  const maxVal = Math.max(...data.map(d => d.collected));
  const chartH = 80;
  const barW = 20;
  const gap = 12;
  const totalW = data.length * (barW + gap) - gap;
  
  let gHtml = "";
  data.forEach((d, i) => {
    const barH = Math.round((d.collected / maxVal) * chartH) || 5;
    const x = i * (barW + gap);
    const y = chartH - barH;
    const isLast = i === data.length - 1;
    const fill = isLast ? "#1976D2" : "#1E2D4A";
    
    gHtml += `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="3" />
        <text x="${x + barW / 2}" y="${chartH + 12}" text-anchor="middle" fill="#6B7280" style="font-size: 8px;">${d.month}</text>
      </g>
    `;
  });
  
  return `
    <div style="overflow-x: auto; width: 100%; display: flex; justify-content: center; padding-top: 4px;">
      <svg width="${totalW}" height="${chartH + 16}" style="display: block;">
        ${gHtml}
      </svg>
    </div>
  `;
}

// 1. Splash Screen specific HTML
function renderSplash() {
  return `
    <div class="ep-splash-bg">
      <div class="ep-logo-wrapper">
        <i data-lucide="wallet" style="width: 40px; height: 40px; color: white;"></i>
      </div>
      <div class="ep-splash-title">ESTATEPAY</div>
      <div class="ep-splash-subtitle">Smart household payments simplified</div>
      
      <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 240px;">
        <button id="btn-splash-get-started" class="ep-btn-primary">
          Get Started
        </button>
        <button id="btn-splash-manager-login" class="ep-btn-outline">
          Estate Manager Login
        </button>
      </div>
    </div>
  `;
}

// 2. Auth Screen HTML
function renderAuth() {
  const isManager = authRole === "manager";
  
  let tabsHtml = "";
  if (!isManager) {
    tabsHtml = `
      <div class="ep-tabs-pill">
        <button class="ep-tab-pill-btn ${authTab === "login" ? "active" : ""}" id="btn-auth-tab-login">Login</button>
        <button class="ep-tab-pill-btn ${authTab === "register" ? "active" : ""}" id="btn-auth-tab-register">Register</button>
      </div>
    `;
  }
  
  return `
    <div class="ep-screen">
      <div class="ep-container">
        <button id="btn-auth-back" class="ep-back-btn">
          <i data-lucide="arrow-left" style="width: 20px; height: 20px;"></i>
        </button>
        
        <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 24px;">
          <div class="ep-logo-wrapper-sm">
            <i data-lucide="wallet" style="width: 28px; height: 28px; color: white;"></i>
          </div>
          <h1 style="color: white; font-size: 18px; font-weight: 800; letter-spacing: 0.25em;">
            ${isManager ? "MANAGER LOGIN" : "ESTATEPAY"}
          </h1>
        </div>
        
        ${tabsHtml}
        
        <div class="ep-input-group" style="flex: 1;">
          ${(!isManager && authTab === "register") ? `
            <input type="text" id="input-auth-name" class="ep-input" placeholder="Enter Full Name" value="${authFullName}">
          ` : ""}
          
          <input type="email" id="input-auth-email" class="ep-input" placeholder="Enter Email Address" value="${authEmail}">
          
          ${!isManager ? `
            <input type="tel" id="input-auth-phone" class="ep-input" placeholder="Enter Phone Number" value="${authPhone}">
          ` : ""}
          
          <div class="ep-input-wrapper">
            <input type="${showPassword ? "text" : "password"}" id="input-auth-password" class="ep-input" placeholder="${(!isManager && authTab === "register") ? "Create Password" : "Enter Password"}" value="${authPassword}">
            <button id="btn-auth-toggle-pwd" class="ep-input-toggle">
              <i data-lucide="${showPassword ? "eye-off" : "eye"}" style="width: 16px; height: 16px;"></i>
            </button>
          </div>
          
          ${(!isManager && authTab === "register") ? `
            <div class="ep-input-wrapper">
              <input type="${showConfirmPassword ? "text" : "password"}" id="input-auth-confirm" class="ep-input" placeholder="Confirm Password" value="${authConfirmPassword}">
              <button id="btn-auth-toggle-confirm" class="ep-input-toggle">
                <i data-lucide="${showConfirmPassword ? "eye-off" : "eye"}" style="width: 16px; height: 16px;"></i>
              </button>
            </div>
          ` : ""}
        </div>
        
        <button id="btn-auth-proceed" class="ep-btn-primary" style="margin-top: 24px;">
          Proceed
        </button>
      </div>
    </div>
  `;
}

// 3. House Entry Screen HTML
function renderHouseEntry() {
  const estateOptions = Object.keys(db.estates)
    .map(estateId => `<option value="${estateId}" ${registerEstateName === estateId ? "selected" : ""}>${db.estates[estateId].name}</option>`)
    .join("");
  const selectedEstateName = registerEstateName ? db.estates[registerEstateName]?.name : "";

  return `
    <div class="ep-screen">
      <div class="ep-container">
        <button id="btn-house-back" class="ep-back-btn">
          <i data-lucide="arrow-left" style="width: 20px; height: 20px;"></i>
        </button>
        
        <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 32px;">
          <div class="ep-logo-wrapper-sm" style="width: 64px; height: 64px; border-radius: 14px; box-shadow: 0 0 30px rgba(25, 118, 210, 0.4);">
            <i data-lucide="wallet" style="width: 32px; height: 32px; color: white;"></i>
          </div>
          <h1 style="color: white; font-size: 18px; font-weight: 800; letter-spacing: 0.25em;">ESTATEPAY</h1>
        </div>
        
        ${householdEntryStep === "search" ? `
          <div style="display: flex; flex-direction: column; gap: 16px;">
            <select id="input-reg-estate" class="ep-input ep-select">
              <option value="">Select Estate / Compound</option>
              ${estateOptions}
            </select>
            <input type="text" id="input-house-number" class="ep-input" placeholder="Enter House Number" value="${houseNumberInput}">
            
            <button id="btn-house-enter" class="ep-btn-primary">
              Enter Household
            </button>
          </div>
        ` : ""}

        ${householdEntryStep === "join" ? `
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <h2 style="color: white; text-align: center; font-size: 14px; margin-bottom: 2px;">Join Existing Household</h2>
            <div style="background: #111827; border: 1px solid #253044; border-radius: 8px; padding: 9px 10px; color: #9CA3AF; font-size: 10px; line-height: 1.4;">
              House ${houseNumberInput} is already registered${selectedEstateName ? ` at ${selectedEstateName}` : ""}. Ask the first account for this house to send you the household invite link.
            </div>
            <input type="text" id="input-household-invite" class="ep-input" placeholder="Paste Household Invite Link" value="${householdInviteInput}">
            <button id="btn-house-join-invite" class="ep-btn-primary" style="background: #10B981; box-shadow: 0 8px 20px rgba(16, 185, 129, 0.2);">
              Join With Invite Link
            </button>
            <button id="btn-house-goto-search" style="background: transparent; border: none; color: #60A5FA; font-size: 12px; cursor: pointer; margin-top: 12px;">
              Back to search
            </button>
          </div>
        ` : ""}

        ${householdEntryStep === "register" ? `
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <h2 style="color: white; text-align: center; font-size: 14px; margin-bottom: 8px;">Register Your Household</h2>
            
            <select id="input-reg-estate" class="ep-input ep-select">
              <option value="">Select Estate / Compound</option>
              ${estateOptions}
            </select>
            <input type="text" id="input-reg-house" class="ep-input" placeholder="House Number" value="${houseNumberInput}">
            
            <button id="btn-house-register" class="ep-btn-primary" style="margin-top: 8px;">
              Register & Continue
            </button>
            
            <button id="btn-house-goto-search" style="background: transparent; border: none; color: #60A5FA; font-size: 12px; cursor: pointer; margin-top: 12px;">
              Back to search
            </button>
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

// 5. Tenant Dashboard HTML
function renderTenantDashboard() {
  const tenantBill = getActiveTenantBill();
  const isDue = tenantBill && getBillBalance(tenantBill) > 0;
  const billBalance = tenantBill ? (tenantBill.balance !== undefined ? tenantBill.balance : tenantBill.amount) : 0;
  const billAmountPaid = tenantBill ? (tenantBill.amountPaid || 0) : 0;
  const balanceView = getBalanceDisplay(billBalance);
  const isPartial = tenantBill && billBalance > 0 && billAmountPaid > 0;
  
  const statusLabels = {
    paid: { label: billBalance < 0 ? "Credit" : "Paid", color: balanceView.color, bg: `${balanceView.color}22`, icon: "check-circle-2" },
    pending: { label: "Unpaid", color: "#EF4444", bg: "#EF444422", icon: "clock" }
  };
  
  const sc = tenantBill ? statusLabels[getBillStatus(tenantBill)] : statusLabels.paid;
  
  let contentHtml = "";
  
  // Get estate announcements for the tenant's estate
  const tenantObj = db.tenants[activePhone];
  const tenantEstateId = tenantObj ? tenantObj.estateId : null;
  const estateAnnouncements = [];
  if (tenantEstateId) {
    Object.keys(db.forum_announcements).forEach(id => {
      if (db.forum_announcements[id].estateId === tenantEstateId) {
        estateAnnouncements.push({ id, ...db.forum_announcements[id] });
      }
    });
    estateAnnouncements.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  }

  if (tenantActiveTab === "home") {
    // Build partial payment progress bar
    const totalAmt = tenantBill ? tenantBill.amount : 0;
    const paidPct = totalAmt > 0 ? Math.round((billAmountPaid / totalAmt) * 100) : 0;
    const partialBar = (isPartial && totalAmt > 0) ? `
      <div style="margin-top: 10px;">
        <div style="display: flex; justify-content: space-between; font-size: 9px; margin-bottom: 3px;">
          <span style="color: #90CAF9;">Paid so far</span>
          <span style="color: #fff; font-weight: 700;">KSh ${billAmountPaid.toLocaleString()} / ${totalAmt.toLocaleString()}</span>
        </div>
        <div style="height: 4px; background: rgba(255,255,255,0.15); border-radius: 999px; overflow: hidden;">
          <div style="width: ${paidPct}%; height: 100%; background: #60A5FA; border-radius: 999px;"></div>
        </div>
      </div>
    ` : "";

    contentHtml = `
      <!-- Balance Card -->
      <div class="ep-balance-card">
        <span class="ep-balance-label">Security Fee — ${tenantBill ? tenantBill.period : "July 2026"}</span>
        <span class="ep-balance-val" style="color: ${balanceView.color};">${balanceView.label}</span>
        <div style="margin-bottom: 4px;">
          <span style="color: #90CAF9; font-size: 9px;">${billBalance < 0 ? "Advance credit" : "Balance Remaining"}</span>
        </div>
        <div class="ep-balance-footer">
          <div>
            <span style="color: #90CAF9; font-size: 9px; display: block;">Due Date</span>
            <span style="color: #fff; font-size: 11px; font-weight: 600;">${tenantBill ? new Date(tenantBill.dueDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "-"}</span>
          </div>
          <span class="ep-status-badge" style="background: ${sc.bg}; color: ${sc.color};">
            <i data-lucide="${sc.icon}" style="width: 12px; height: 12px;"></i>
            ${sc.label}
          </span>
        </div>
        ${partialBar}
      </div>
      
      <!-- Toast Alert -->
      ${showSuccessToast ? `
        <div class="ep-toast">
          <i data-lucide="check-circle-2" style="width: 16px; height: 16px; color: #10B981;"></i>
          <span>${successToastMessage}</span>
        </div>
      ` : ""}
      
      <!-- Security Payment item -->
      <div>
        <h3 style="color: white; font-size: 13px; font-weight: 700; margin-bottom: 8px;">Security Payment</h3>
        <button id="btn-tenant-pay-item" class="ep-item-card" ${!isDue ? "disabled" : ""}>
          <div class="ep-item-icon-box" style="background: #EF444422;">
            <i data-lucide="shield" style="width: 20px; height: 20px; color: #EF4444;"></i>
          </div>
          <div class="ep-item-details">
            <div class="ep-item-title">Security Fee</div>
            <div class="ep-item-desc">${tenantBill ? tenantBill.period : "July 2026"} Security Levy</div>
            <div class="ep-item-meta">Balance: KSh ${billBalance.toLocaleString()} of ${tenantBill ? tenantBill.amount.toLocaleString() : "0"}</div>
          </div>
          <div class="ep-item-right">
            <div class="ep-item-amount">KSh ${billBalance.toLocaleString()}</div>
            <span class="ep-status-badge" style="background: ${sc.bg}; color: ${sc.color}; font-size: 8px; padding: 1px 4px;">
              ${sc.label}
            </span>
          </div>
        </button>
      </div>

      <!-- Quick Actions Grid -->
      <div>
        <h3 style="color: white; font-size: 13px; font-weight: 700; margin-bottom: 8px;">Quick Actions</h3>
        <div class="ep-actions-grid">
          <button id="btn-action-pay" class="ep-action-btn" ${!isDue ? "disabled" : ""}>
            <i data-lucide="credit-card" style="width: 18px; height: 18px; color: #1976D2;"></i>
            <span>Pay Now</span>
          </button>
          <button id="btn-action-history" class="ep-action-btn">
            <i data-lucide="receipt" style="width: 18px; height: 18px; color: #1976D2;"></i>
            <span>View Receipts</span>
          </button>
        </div>
      </div>
    `;
  } else if (tenantActiveTab === "announcements") {
    const announcementsHtml = estateAnnouncements.length > 0 ? estateAnnouncements.map(ann => `
      <div style="background: ${ann.pinned ? 'rgba(25,118,210,0.12)' : '#111120'}; border: 1px solid ${ann.pinned ? '#1976D2' : '#1E1E30'}; border-radius: 10px; padding: 10px 12px;">
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          ${ann.pinned ? '<i data-lucide="pin" style="width: 10px; height: 10px; color: #1976D2; flex-shrink: 0;"></i>' : '<i data-lucide="megaphone" style="width: 10px; height: 10px; color: #9CA3AF; flex-shrink: 0;"></i>'}
          <span style="color: ${ann.pinned ? '#60A5FA' : 'white'}; font-weight: 700; font-size: 11px;">${ann.title}</span>
        </div>
        <p style="color: #9CA3AF; font-size: 10px; line-height: 1.5; margin: 0 0 4px;">${ann.body}</p>
        <span style="color: #4B5563; font-size: 9px;">${new Date(ann.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
      </div>
    `).join("") : `<p style="color: #4B5563; font-size: 11px; font-style: italic; text-align: center; padding: 8px 0;">No announcements yet.</p>`;

    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Estate Forum</h2>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${announcementsHtml}
      </div>
    `;
  } else if (tenantActiveTab === "payments") {
    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Security Payment</h2>
      
      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 12px; padding: 12px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="ep-item-icon-box" style="background: #EF444422; width: 36px; height: 36px;">
            <i data-lucide="shield" style="width: 18px; height: 18px; color: #EF4444;"></i>
          </div>
          <div style="flex: 1;">
            <p style="color: white; font-weight: 600; font-size: 13px; margin: 0;">Security Fee</p>
            <p style="color: #6B7280; font-size: 10px; margin: 1px 0 0;">${tenantBill ? tenantBill.period : "July 2026"} Security Levy</p>
          </div>
          <span class="ep-status-badge" style="background: ${sc.bg}; color: ${sc.color}; font-size: 9px; padding: 1px 5px;">
            ${sc.label}
          </span>
        </div>
        
        <div style="background: #1A1A2A; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #9CA3AF; font-size: 11px;">Total Bill</span>
            <span style="color: #E5E7EB; font-size: 12px;">KSh ${tenantBill ? tenantBill.amount.toLocaleString() : "0"}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #9CA3AF; font-size: 11px;">Paid So Far</span>
            <span style="color: #10B981; font-size: 12px; font-weight: 600;">KSh ${billAmountPaid.toLocaleString()}</span>
          </div>
          <div style="display: flex; justify-content: space-between; border-top: 1px solid #2A2A3A; padding-top: 6px; margin-top: 2px;">
            <span style="color: #9CA3AF; font-size: 11px;">Balance Due</span>
            <span style="color: white; font-weight: 800; font-size: 15px;">KSh ${billBalance.toLocaleString()}</span>
          </div>
          ${billAmountPaid > 0 ? `
            <div style="margin-top: 2px;">
              <div style="height: 4px; background: #2A2A3A; border-radius: 999px; overflow: hidden;">
                <div style="width: ${Math.round((billAmountPaid/(tenantBill ? tenantBill.amount : 1))*100)}%; height: 100%; background: linear-gradient(90deg, #10B981, #60A5FA); border-radius: 999px;"></div>
              </div>
              <span style="color: #6B7280; font-size: 9px;">${Math.round((billAmountPaid/(tenantBill ? tenantBill.amount : 1))*100)}% paid</span>
            </div>
          ` : ""}
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #9CA3AF; font-size: 11px;">Due Date</span>
            <span style="color: #E5E7EB; font-size: 11px;">${tenantBill ? new Date(tenantBill.dueDate).toLocaleDateString() : "-"}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #9CA3AF; font-size: 11px;">House</span>
            <span style="color: #E5E7EB; font-size: 11px;">House ${houseNumberInput}</span>
          </div>
        </div>
        
        ${isDue ? `
          <button id="btn-payments-pay-now" class="ep-btn-primary" style="padding: 10px;">
            Pay Balance — KSh ${billBalance.toLocaleString()}
          </button>
        ` : `
          <div style="background: #10B98122; border: 1px solid #10B981; color: #10B981; border-radius: 8px; padding: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 600; font-size: 12px;">
            <i data-lucide="check-circle-2" style="width: 14px; height: 14px;"></i>
            <span>Payment Completed</span>
          </div>
        `}
      </div>
    `;
  } else if (tenantActiveTab === "history") {
    const txnList = getTenantPaymentHistory(activePhone);
    let txnsHtml = "";

    if (txnList.length === 0) {
      txnsHtml = `<p style="color: #6B7280; font-size: 11px; text-align: center; padding: 16px 0;">No successful payments yet.</p>`;
    } else {
      txnList.forEach(item => {
        const formattedDate = new Date(item.completedAt || item.initiatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const ref = item.mpesaReceiptNumber || `EP-TXN-${item.id.substr(-4)}`;
        const bill = item.billId ? db.bills[item.billId] : null;
        const periodLabel = bill?.period ? `Security Fee - ${bill.period}` : "Security Fee";

        txnsHtml += `
          <div class="ep-history-item" style="padding: 10px 12px;">
            <div class="ep-item-icon-box" style="background: #10B98122; width: 32px; height: 32px;">
              <i data-lucide="shield" style="width: 16px; height: 16px; color: #10B981;"></i>
            </div>
            <div style="flex: 1;">
              <p style="color: white; font-weight: 600; font-size: 11px; margin: 0;">${periodLabel}</p>
              <p style="color: #6B7280; font-size: 9px; margin: 1px 0 0;">${formattedDate} · ${ref}</p>
            </div>
            <div style="text-align: right;">
              <p style="color: #10B981; font-weight: 700; font-size: 12px; margin: 0;">KSh ${item.amount.toLocaleString()}</p>
              <span style="color: #10B981; font-size: 8px; font-weight: 600;">Paid</span>
            </div>
          </div>
        `;
      });
    }

    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Payment History</h2>
      <div class="ep-history-list">
        ${txnsHtml}
      </div>
    `;
  } else if (tenantActiveTab === "profile") {
    const tenant = db.tenants[activePhone];
    const estate = db.estates[tenant.estateId || "estate-1"] || { name: "Greenview Estate" };
    const household = getActiveTenantUnit();
    const isHouseholdOwner = household?.unit.householdOwnerPhone === activePhone;
    const inviteLink = getHouseholdInviteLink(household?.unit);
    const householdMembers = Object.keys(db.tenants)
      .map(phone => ({ phone, ...db.tenants[phone] }))
      .filter(member => member.estateId === tenant.estateId && member.unitId === tenant.unitId && member.role !== "manager" && member.role !== "admin");
    const householdMembersHtml = householdMembers.length ? householdMembers.map(member => `
          <div style="display: flex; align-items: center; gap: 8px; background: #1A1A2A; border-radius: 6px; padding: 6px 8px;">
            <div style="position: relative; width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #1565C0, #1976D2); display: flex; align-items: center; justify-content: center; color: white;">
              <i data-lucide="user" style="width: 12px; height: 12px;"></i>
              <span style="position: absolute; bottom: 0; right: 0; width: 6px; height: 6px; border-radius: 50%; background: #10B981; border: 1px solid #1A1A2A;"></span>
            </div>
            <div style="flex: 1;">
              <p style="color: white; font-size: 10px; font-weight: 600; margin: 0;">${member.fullName || `Resident (${member.phone.substr(-4)})`}</p>
              <p style="color: #6B7280; font-size: 8px; margin: 0;">${household?.unit.householdOwnerPhone === member.phone ? "Registerer" : "Member"} - ${member.phone}</p>
            </div>
          </div>
    `).join("") : `
          <div style="background: #1A1A2A; border-radius: 6px; padding: 10px; color: #6B7280; font-size: 10px; text-align: center;">
            No household members added yet.
          </div>
    `;
    
    contentHtml = `
      <div style="display: flex; flex-direction: column; align-items: center; padding: 8px 0 12px;">
        <div style="width: 52px; height: 52px; border-radius: 50%; background: linear-gradient(135deg, #1565C0, #1976D2); display: flex; align-items: center; justify-content: center; color: white; margin-bottom: 8px;">
          <i data-lucide="user" style="width: 26px; height: 26px;"></i>
        </div>
        <h3 style="color: white; font-size: 14px; font-weight: 700; margin: 0;">${tenant ? tenant.fullName : "Tenant"}</h3>
        <p style="color: #9CA3AF; font-size: 10px; margin: 2px 0 0;">House ${houseNumberInput}</p>
      </div>
      
      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 6px; padding: 10px;">
        <div class="ep-detail-row" style="padding: 4px 0;"><span class="ep-detail-label">House Number</span><span class="ep-detail-val">${houseNumberInput}</span></div>
        <div class="ep-detail-row" style="padding: 4px 0;"><span class="ep-detail-label">Estate</span><span class="ep-detail-val">${estate.name}</span></div>
        <div class="ep-detail-row" style="padding: 4px 0;"><span class="ep-detail-label">Phone</span><span class="ep-detail-val">${activePhone}</span></div>
      </div>

      ${isHouseholdOwner ? `
        <div class="ep-detail-card" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span style="color: #9CA3AF; font-size: 11px; font-weight: 600;">Household Invite Link</span>
            <span style="background: rgba(16, 185, 129, 0.15); color: #34D399; font-size: 8px; font-weight: 600; padding: 1px 4px; border-radius: 12px;">Owner</span>
          </div>
          <div style="background: #111827; border: 1px solid #253044; border-radius: 6px; padding: 7px; color: #9CA3AF; font-size: 9px; line-height: 1.3; word-break: break-all;">${inviteLink}</div>
          <button id="btn-send-household-link" class="ep-btn-primary" style="padding: 9px; font-size: 11px; background: #10B981; box-shadow: 0 8px 20px rgba(16, 185, 129, 0.18);">
            <i data-lucide="send" style="width: 13px; height: 13px;"></i> Send Household Link
          </button>
        </div>
      ` : ""}
      
      <!-- Household members list -->
      <div class="ep-detail-card" style="padding: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="color: #9CA3AF; font-size: 11px; font-weight: 600;">Household Members</span>
          <span style="background: rgba(25, 118, 210, 0.15); color: #60A5FA; font-size: 8px; font-weight: 600; padding: 1px 4px; border-radius: 12px;">House ${houseNumberInput}</span>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${householdMembersHtml}
        </div>
      </div>
      
      <button id="btn-tenant-signout" class="ep-btn-primary" style="background: rgba(239, 68, 68, 0.15); border: 1px solid #EF4444; color: #EF4444; box-shadow: none; padding: 10px; font-size: 12px;">
        <i data-lucide="log-out" style="width: 14px; height: 14px;"></i> Sign Out
      </button>
    `;
  }
  
  // Render payment sheet if open
  let paymentModalHtml = "";
  if (payingBillId && tenantBill) {
    const defaultPayAmt = paymentAmountInput || Math.max(billBalance, tenantBill.amount).toString();
    paymentModalHtml = `
      <div class="ep-modal-overlay">
        <div class="ep-modal-content" id="payment-modal-container">
          <div class="ep-modal-header" style="margin-bottom: 12px;">
            <span class="ep-modal-title">Make Payment</span>
            <button class="ep-modal-close" id="btn-close-payment-modal"><i data-lucide="x" style="width: 18px; height: 18px;"></i></button>
          </div>
          
          <!-- Bill summary -->
          <div style="background: #1A1A2A; border-radius: 10px; padding: 10px; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <div class="ep-item-icon-box" style="background: #EF444422; width: 32px; height: 32px;">
                <i data-lucide="shield" style="width: 16px; height: 16px; color: #EF4444;"></i>
              </div>
              <div style="flex: 1;">
                <p style="color: white; font-weight: 600; font-size: 12px; margin: 0;">Security Fee — ${tenantBill.period}</p>
                <p style="color: #6B7280; font-size: 10px; margin: 1px 0 0;">House ${houseNumberInput}</p>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; padding: 4px 0;">
              <span style="color: #9CA3AF;">Total Bill</span>
              <span style="color: #E5E7EB;">KSh ${tenantBill.amount.toLocaleString()}</span>
            </div>
            ${billAmountPaid > 0 ? `
              <div style="display: flex; justify-content: space-between; font-size: 11px; padding: 4px 0;">
                <span style="color: #9CA3AF;">Paid So Far</span>
                <span style="color: #10B981; font-weight: 600;">KSh ${billAmountPaid.toLocaleString()}</span>
              </div>
            ` : ""}
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #2A2A3A; padding-top: 8px; margin-top: 4px;">
              <span style="color: #9CA3AF; font-size: 11px;">Current Balance</span>
              <span style="color: ${balanceView.color}; font-weight: 800; font-size: 16px;">${balanceView.label}</span>
            </div>
          </div>

          <!-- Custom amount input -->
          <div style="margin-bottom: 14px;">
            <label style="color: #9CA3AF; font-size: 11px; display: block; margin-bottom: 6px;">Enter Amount to Pay (KSh)</label>
            <div style="position: relative;">
              <span style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #6B7280; font-size: 13px; font-weight: 600;">KSh</span>
              <input
                type="number"
                id="input-payment-amount"
                class="ep-input"
                style="padding-left: 44px; font-size: 16px; font-weight: 700; color: white;"
                placeholder="${billBalance}"
                value="${defaultPayAmt}"
                min="1"
              >
            </div>
            <p style="color: #4B5563; font-size: 10px; margin-top: 4px;">You can pay any amount, including paying ahead.</p>
          </div>
          
          <button id="btn-confirm-payment-trigger" class="ep-btn-primary" style="padding: 12px; font-size: 13px;">
            <i data-lucide="credit-card" style="width: 14px; height: 14px;"></i>
            Confirm & Pay via M-Pesa
          </button>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="ep-screen">
      <div class="ep-dashboard">
        <!-- Header -->
        <div class="ep-dashboard-header">
          <div class="ep-header-profile">
            <div class="ep-header-avatar">
              <i data-lucide="wallet" style="width: 18px; height: 18px;"></i>
            </div>
            <div class="ep-header-info">
              <p class="ep-welcome">Welcome back</p>
              <p class="ep-user-title">House ${houseNumberInput || "A-10"}</p>
            </div>
          </div>
          <button class="ep-header-btn" id="btn-tenant-nav-notifications">
            <i data-lucide="bell" style="width: 16px; height: 16px;"></i>
            ${isDue ? `<span class="ep-badge-dot"></span>` : ""}
          </button>
        </div>
        
        <!-- Tab Content -->
        <div class="ep-dashboard-content">
          ${contentHtml}
        </div>
        
        <!-- Bottom Tab Navigation -->
        <div class="ep-bottom-nav">
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "home" ? "active" : ""}" id="btn-tenant-tab-home">
            <i data-lucide="home" style="width: 18px; height: 18px;"></i>
            <span>Home</span>
          </button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "announcements" ? "active" : ""}" id="btn-tenant-tab-announcements">
            <i data-lucide="megaphone" style="width: 18px; height: 18px;"></i>
            <span>Forum</span>
          </button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "payments" ? "active" : ""}" id="btn-tenant-tab-pay">
            <i data-lucide="credit-card" style="width: 18px; height: 18px;"></i>
            <span>Pay</span>
          </button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "history" ? "active" : ""}" id="btn-tenant-tab-history">
            <i data-lucide="receipt" style="width: 18px; height: 18px;"></i>
            <span>History</span>
          </button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "profile" ? "active" : ""}" id="btn-tenant-tab-profile">
            <i data-lucide="user" style="width: 18px; height: 18px;"></i>
            <span>Profile</span>
          </button>
        </div>
        
        <!-- Payment Modal overlay -->
        ${paymentModalHtml}
      </div>
    </div>
  `;
}

// 6. Manager Dashboard HTML
function renderManagerDashboard() {
  const tenantsList = getTenantList();
  
  // Calculate sums dynamically based on actual bills in database
  let totalCollected = 0;
  let totalExpected = 0;
  let settledCount = 0;
  let pendingCount = 0;
  let creditCount = 0;
  
  let categoryAmounts = {
    settled: 0,
    pending: 0,
    credit: 0
  };

  tenantsList.forEach(t => {
    const bill = t.bill;
    if (bill) {
      totalCollected += bill.amountPaid || 0;
      totalExpected += bill.amount || 0;
    } else {
      const unit = SEED_DATA.units[t.estateId]?.[t.unitId];
      totalExpected += unit?.monthlyRate || 0;
    }

    if (t.balance < 0) {
      creditCount++;
      categoryAmounts.credit += Math.abs(t.balance);
    } else if (t.balance === 0) {
      settledCount++;
    } else {
      pendingCount++;
      categoryAmounts.pending += t.balance;
    }
  });

  const totalUnits = tenantsList.length;
  const collectionRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;
  
  const statusLabels = {
    paid: { label: "Settled", color: "#60A5FA", bg: "#60A5FA20" },
    pending: { label: "Unpaid", color: "#EF4444", bg: "#EF444420" }
  };
  
  // Filter tenants for display
  const filteredTenants = tenantsList.filter(t => {
    const matchSearch = t.name.toLowerCase().includes(managerSearch.toLowerCase()) || t.houseNo.toLowerCase().includes(managerSearch.toLowerCase());
    const matchFilter = managerFilterStatus === "all" || t.security === managerFilterStatus;
    return matchSearch && matchFilter;
  });
  
  let contentHtml = "";
  
  if (managerActiveTab === "overview") {
    contentHtml = `
      <!-- Stats Row -->
      <div class="ep-manager-stats-2col">
        <div class="ep-stat-card-gradient">
          <span class="ep-stat-label-gradient">Collected (Jul)</span>
          <div class="ep-stat-val-lg">KSh ${totalCollected.toLocaleString()}</div>
          <div class="ep-stat-meta-green">
            <i data-lucide="trending-up" style="width: 12px; height: 12px;"></i>
            <span>${collectionRate}% rate</span>
          </div>
        </div>
        <div class="ep-stat-card">
          <span class="ep-stat-label">Expected (Jul)</span>
          <div class="ep-stat-val-lg">KSh ${totalExpected.toLocaleString()}</div>
          <div class="ep-stat-meta-red">KSh ${(totalExpected - totalCollected).toLocaleString()} outstanding</div>
        </div>
      </div>
      
      <!-- Stats Grid -->
      <div class="ep-manager-stats-3col">
        <div class="ep-stat-card" style="border-color: rgba(25, 118, 210, 0.15);">
          <i data-lucide="home" style="width: 14px; height: 14px; color: #1976D2;"></i>
          <div class="ep-stat-val" style="margin-top: 2px; font-size: 14px;">${totalUnits}</div>
          <span class="ep-stat-label">Total Units</span>
        </div>
        <div class="ep-stat-card" style="border-color: rgba(16, 185, 129, 0.15);">
          <i data-lucide="check-circle-2" style="width: 14px; height: 14px; color: #10B981;"></i>
          <div class="ep-stat-val" style="margin-top: 2px; font-size: 14px;">${settledCount}</div>
          <span class="ep-stat-label">Zero Balance</span>
        </div>
        <div class="ep-stat-card" style="border-color: rgba(239, 68, 68, 0.15);">
          <i data-lucide="alert-circle" style="width: 14px; height: 14px; color: #EF4444;"></i>
          <div class="ep-stat-val" style="margin-top: 2px; font-size: 14px;">${pendingCount}</div>
          <span class="ep-stat-label">Unpaid</span>
        </div>
      </div>
      
      <!-- Legend info card -->
      <div class="ep-info-card" style="background: #0D1525; border-color: #1E2D4A; padding: 10px;">
        <p style="color: #60A5FA; font-size: 11px; font-weight: 600; margin-bottom: 4px;">What do these numbers mean?</p>
        <p style="color: #9CA3AF; font-size: 10px; line-height: 1.4; margin: 0;">
          <span style="color: white; font-weight: 600;">${totalUnits} Total Units</span> — all registered houses in estate.<br>
          <span style="color: #10B981; font-weight: 600;">${settledCount} Zero Balance</span> - exactly settled.<br>
          <span style="color: #EF4444; font-weight: 600;">${pendingCount} Unpaid</span> - balance remains.
        </p>
      </div>
      
      <!-- Progress Bar -->
      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <span style="color: white; font-weight: 600;">Security Fee Collection</span>
          <span style="color: #1976D2; font-weight: 700;">${collectionRate}%</span>
        </div>
        <div style="height: 5px; background: #1A1A2A; border-radius: 999px; overflow: hidden;">
          <div style="width: ${collectionRate}%; height: 100%; background: linear-gradient(90deg, #1565C0, #1976D2); border-radius: 999px;"></div>
        </div>
      </div>
      
      <!-- Bar Chart -->
      <div class="ep-detail-card" style="padding: 10px 12px;">
        <p style="color: white; font-size: 11px; font-weight: 600; margin-bottom: 8px;">Monthly Security Collections</p>
        ${renderManagerBarChart(monthlyData)}
      </div>
      
      <!-- Unpaid houses list -->
      <div>
        <h3 style="color: white; font-size: 13px; font-weight: 700; margin-bottom: 8px;">Unpaid Houses</h3>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${tenantsList.filter(t => t.balance > 0).map(t => `
            <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 10px; padding: 8px 10px; display: flex; align-items: center; gap: 8px;">
              <i data-lucide="alert-circle" style="width: 14px; height: 14px; color: #EF4444; flex-shrink: 0;"></i>
              <div style="flex: 1;">
                <p style="color: white; font-size: 11px; font-weight: 600; margin: 0;">House ${t.houseNo}</p>
                <p style="color: #9CA3AF; font-size: 9px; margin: 1px 0 0;">Registered by ${t.name}</p>
              </div>
              <span style="color: #EF4444; font-size: 10px; font-weight: 700;">${t.balanceLabel}</span>
              <button class="btn-manager-notify-tenant" data-id="${t.id}" style="background: transparent; border: none; color: #1976D2; font-size: 10px; font-weight: 600; cursor: pointer; padding: 2px;">
                Notify
              </button>
            </div>
          `).join("") || '<div style="color: #6B7280; font-size: 11px; font-style: italic; text-align: center; padding: 10px 0;">No unpaid houses.</div>'}
        </div>
      </div>    `;
  } else if (managerActiveTab === "tenants") {
    let tenantsHtml = "";
    filteredTenants.forEach(t => {
      const balanceView = getBalanceDisplay(t.balance);
      const balanceBg = t.balance < 0 ? "#10B98120" : (t.balance === 0 ? "#60A5FA20" : "#EF444420");

      tenantsHtml += `
        <button class="ep-item-card btn-manager-tenant-row" data-id="${t.id}" style="margin-bottom: 6px; padding: 10px;">
          <div style="flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px;">
              <div>
                <p style="color: white; font-weight: 700; font-size: 12px; margin: 0;">House ${t.houseNo}</p>
                <p style="color: #6B7280; font-size: 9px; margin: 1px 0 0;">Registered by ${t.name}</p>
              </div>
              <span style="color: ${balanceView.color}; font-size: 11px; font-weight: 800; white-space: nowrap;">${balanceView.label}</span>
            </div>
            <div style="background: ${balanceBg}; border-radius: 4px; padding: 4px 8px; display: flex; align-items: center; gap: 4px; font-size: 9px; color: ${balanceView.color}; font-weight: 600;">
              <i data-lucide="home" style="width: 10px; height: 10px;"></i>
              <span>${t.block}</span>
              <span style="margin-left: auto;">${t.balance > 0 ? "Unpaid" : (t.balance < 0 ? "Overpaid" : "Zero balance")}</span>
            </div>
          </div>
        </button>
      `;
    });
    
    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Registered Houses</h2>
      
      <div class="ep-search-container">
        <i data-lucide="search" class="ep-search-icon" style="width: 12px; height: 12px;"></i>
        <input type="text" id="input-manager-search" class="ep-search-input" placeholder="Search house or registerer..." value="${managerSearch}">
      </div>
      
      <div class="ep-info-card" style="background: #0D1525; border-color: #1E2D4A; padding: 8px;">
        <p style="color: #60A5FA; font-size: 10px; font-weight: 600; margin-bottom: 2px;">Balance color guide</p>
        <p style="color: #9CA3AF; font-size: 9px; line-height: 1.4; margin: 0;">
          <span style="color: #EF4444; font-weight: 600;">Red</span> - unpaid balance.<br>
          <span style="color: #10B981; font-weight: 600;">Green</span> - overpaid/credit.<br>
          <span style="color: #60A5FA; font-weight: 600;">Blue</span> - zero balance.
        </p>
      </div>
      
      <div class="ep-horizontal-tags">
        <button class="ep-tag-btn ${managerFilterStatus === "all" ? "active" : ""}" data-filter="all">All</button>
        <button class="ep-tag-btn ${managerFilterStatus === "pending" ? "active" : ""}" data-filter="pending">Unpaid</button>
        <button class="ep-tag-btn ${managerFilterStatus === "paid" ? "active" : ""}" data-filter="paid">Settled</button>
      </div>
      
      <div style="display: flex; flex-direction: column;">
        ${tenantsHtml || '<div style="color: #6B7280; font-size: 11px; text-align: center; padding: 16px 0;">No matching houses found.</div>'}
      </div>
    `;  } else if (managerActiveTab === "notices") {
    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Issue Notices</h2>
      
      ${showNoticeSentToast ? `
        <div class="ep-toast">
          <i data-lucide="check-circle-2" style="width: 16px; height: 16px; color: #10B981;"></i>
          <span>Notice sent successfully!</span>
        </div>
      ` : ""}
      
      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 10px; padding: 10px;">
        <h3 style="color: white; font-size: 12px; font-weight: 600; margin: 0;">Compose Notice</h3>
        
        <div>
          <label style="color: #9CA3AF; font-size: 10px; display: block; margin-bottom: 4px;">Send To</label>
          <select id="select-notice-target" class="ep-select" style="padding: 8px;">
            <option value="all" ${noticeTarget === "all" ? "selected" : ""}>All Tenants</option>
            <option value="overdue" ${noticeTarget === "overdue" ? "selected" : ""}>All Overdue Tenants</option>
            ${tenantsList.map(t => `<option value="${t.id}" ${noticeTarget === t.id ? "selected" : ""}>${t.name} (House ${t.houseNo})</option>`).join("")}
          </select>
        </div>
        
        <div>
          <label style="color: #9CA3AF; font-size: 10px; display: block; margin-bottom: 4px;">Notice Message</label>
          <textarea id="textarea-notice-msg" class="ep-textarea" placeholder="Type your notice message here...">${noticeText}</textarea>
        </div>
        
        <button id="btn-manager-send-notice" class="ep-btn-primary" style="padding: 10px; font-size: 12px;">
          <i data-lucide="send" style="width: 12px; height: 12px;"></i> Send Notice
        </button>
      </div>
      
      <div>
        <h3 style="color: white; font-size: 11px; font-weight: 600; margin-bottom: 6px;">Quick Templates</h3>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <button class="ep-item-card btn-notice-template" data-template="This is a reminder that your monthly security fee of KSh 1,500 is due. Please settle promptly." style="padding: 8px; font-size: 10px; color: #9CA3AF;">
            Reminder: Security fee KSh 1,500 is due. Please settle promptly.
          </button>
          <button class="ep-item-card btn-notice-template" data-template="Security fee for this month is pending. Kindly make payment at your earliest convenience." style="padding: 8px; font-size: 10px; color: #9CA3AF;">
            Reminder: Security fee is pending. Kindly settle soon.
          </button>
        </div>
      </div>
      
      <div>
        <h3 style="color: white; font-size: 11px; font-weight: 600; margin-bottom: 6px;">Recently Sent</h3>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${sentNoticesList.map(n => `
            <div class="ep-detail-card" style="padding: 8px; font-size: 10px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                <span style="color: #1976D2; font-weight: 600;">To: ${n.to}</span>
                <span style="color: #6B7280; font-size: 8px;">${n.date}</span>
              </div>
              <p style="color: #9CA3AF; margin: 0; line-height: 1.3;">${n.message}</p>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  } else if (managerActiveTab === "announcements") {
    // Pull all existing announcements for this estate
    const managerPhone = activePhone;
    const managerTenant = db.tenants[managerPhone];
    const estateId = managerTenant ? managerTenant.estateId : "estate-1";
    const annList = [];
    Object.keys(db.forum_announcements).forEach(id => {
      if (db.forum_announcements[id].estateId === estateId) {
        annList.push({ id, ...db.forum_announcements[id] });
      }
    });
    annList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const annHistoryHtml = annList.length > 0 ? annList.map(ann => `
      <div class="ep-detail-card" style="padding: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
          <span style="color: ${ann.pinned ? '#60A5FA' : 'white'}; font-weight: 700; font-size: 11px; flex: 1;">
            ${ann.pinned ? '<span style="color:#1976D2;">📌</span> ' : ''}${ann.title}
          </span>
          <span style="color: #4B5563; font-size: 9px; margin-left: 8px;">${new Date(ann.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        </div>
        <p style="color: #9CA3AF; font-size: 10px; line-height: 1.4; margin: 0;">${ann.body}</p>
      </div>
    `).join("") : `<p style="color: #4B5563; font-size: 11px; font-style: italic; text-align: center; padding: 12px 0;">No announcements posted yet.</p>`;

    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Estate Announcements</h2>

      ${showAnnouncementSentToast ? `
        <div class="ep-toast">
          <i data-lucide="megaphone" style="width: 16px; height: 16px; color: #10B981;"></i>
          <span>Announcement posted successfully!</span>
        </div>
      ` : ""}

      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 10px; padding: 10px;">
        <h3 style="color: white; font-size: 12px; font-weight: 600; margin: 0;">Post New Announcement</h3>
        <div>
          <label style="color: #9CA3AF; font-size: 10px; display: block; margin-bottom: 4px;">Title</label>
          <input type="text" id="input-ann-title" class="ep-input" placeholder="e.g. Water Shutdown Notice" value="${managerAnnouncementTitle}">
        </div>
        <div>
          <label style="color: #9CA3AF; font-size: 10px; display: block; margin-bottom: 4px;">Message</label>
          <textarea id="textarea-ann-body" class="ep-textarea" placeholder="Type your announcement here...">${managerAnnouncementBody}</textarea>
        </div>
        <button id="btn-manager-post-announcement" class="ep-btn-primary" style="padding: 10px; font-size: 12px;">
          <i data-lucide="megaphone" style="width: 12px; height: 12px;"></i> Post Announcement
        </button>
      </div>

      <div>
        <h3 style="color: white; font-size: 11px; font-weight: 600; margin-bottom: 6px;">Posted Announcements</h3>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${annHistoryHtml}
        </div>
      </div>
    `;
  } else if (managerActiveTab === "reports") {
    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Reports</h2>
      
      <div class="ep-stat-card-gradient" style="padding: 12px;">
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
          <i data-lucide="shield" style="width: 16px; height: 16px; color: white;"></i>
          <span style="color: white; font-weight: 600; font-size: 12px;">Security Fee — July 2026</span>
        </div>
        <div style="color: white; font-size: 20px; font-weight: 800;">KSh ${totalCollected.toLocaleString()}</div>
        <p style="color: #90CAF9; font-size: 10px; margin: 2px 0 8px;">collected of KSh ${totalExpected.toLocaleString()} expected</p>
        <div style="height: 4px; background: rgba(255,255,255,0.2); border-radius: 999px; overflow: hidden;">
          <div style="width: ${collectionRate}%; height: 100%; background: white; border-radius: 999px;"></div>
        </div>
      </div>
      
      <div class="ep-detail-card" style="display: flex; flex-direction: column; gap: 10px; padding: 10px;">
        <h3 style="color: white; font-size: 11px; font-weight: 600; margin: 0;">Balance Breakdown</h3>
        
        <div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px;">
            <span style="color: #60A5FA; font-weight: 600;">Zero Balance (${settledCount} houses)</span>
            <span style="color: #9CA3AF;">KSh 0</span>
          </div>
          <div style="height: 4px; background: #1A1A2A; border-radius: 999px; overflow: hidden;">
            <div style="width: ${totalUnits > 0 ? (settledCount / totalUnits * 100) : 0}%; height: 100%; background: #60A5FA;"></div>
          </div>
        </div>

        <div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px;">
            <span style="color: #10B981; font-weight: 600;">Overpaid (${creditCount} houses)</span>
            <span style="color: #9CA3AF;">KSh ${categoryAmounts.credit.toLocaleString()}</span>
          </div>
          <div style="height: 4px; background: #1A1A2A; border-radius: 999px; overflow: hidden;">
            <div style="width: ${totalExpected > 0 ? (categoryAmounts.credit / totalExpected * 100) : 0}%; height: 100%; background: #10B981;"></div>
          </div>
        </div>
        
        <div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px;">
            <span style="color: #EF4444; font-weight: 600;">Unpaid (${pendingCount} houses)</span>
            <span style="color: #9CA3AF;">KSh ${categoryAmounts.pending.toLocaleString()}</span>
          </div>
          <div style="height: 4px; background: #1A1A2A; border-radius: 999px; overflow: hidden;">
            <div style="width: ${totalExpected > 0 ? (categoryAmounts.pending / totalExpected * 100) : 0}%; height: 100%; background: #EF4444;"></div>
          </div>
        </div>
      </div>      <div class="ep-detail-card" style="padding: 0; overflow: hidden;">
        <div style="padding: 10px 12px; border-bottom: 1px solid #1E1E30;">
          <p style="color: white; font-size: 11px; font-weight: 600; margin: 0;">July 2026 Summary</p>
        </div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Fee Per Unit</span><span class="ep-detail-val">Varies by unit</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Total Units</span><span class="ep-detail-val">${totalUnits}</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Zero Balance Houses</span><span class="ep-detail-val" style="color: #10B981;">${settledCount}/${totalUnits}</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Unpaid Houses</span><span class="ep-detail-val" style="color: #EF4444;">${pendingCount}</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Total Expected</span><span class="ep-detail-val">KSh ${totalExpected.toLocaleString()}</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px;"><span class="ep-detail-label">Total Collected</span><span class="ep-detail-val" style="color: #1976D2;">KSh ${totalCollected.toLocaleString()}</span></div>
        <div class="ep-detail-row" style="padding: 8px 12px; border-bottom: none;"><span class="ep-detail-label">Outstanding</span><span class="ep-detail-val" style="color: #EF4444;">KSh ${(totalExpected - totalCollected).toLocaleString()}</span></div>
      </div>
    `;
  }
  
  // Render tenant details modal if open
  let modalHtml = "";
  if (selectedTenant) {
    const balanceView = getBalanceDisplay(selectedTenant.balance);
    const balanceBg = selectedTenant.balance < 0 ? "#10B98120" : (selectedTenant.balance === 0 ? "#60A5FA20" : "#EF444420");
    modalHtml = `
      <div class="ep-modal-overlay">
        <div class="ep-modal-content" id="tenant-detail-modal-container">
          <div class="ep-modal-header" style="margin-bottom: 12px;">
            <span class="ep-modal-title">${selectedTenant.name}</span>
            <button class="ep-modal-close" id="btn-close-tenant-modal"><i data-lucide="x" style="width: 18px; height: 18px;"></i></button>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: 11px;">
            <div style="display: flex; justify-content: space-between;"><span style="color: #6B7280;">House No.</span><span style="color: white;">House ${selectedTenant.houseNo}</span></div>
            <div style="display: flex; justify-content: space-between;"><span style="color: #6B7280;">Block</span><span style="color: white;">${selectedTenant.block}</span></div>
            <div style="display: flex; justify-content: space-between;"><span style="color: #6B7280;">Phone</span><span style="color: white;">${selectedTenant.phone}</span></div>
          </div>
          
          <div style="background: ${balanceBg}; border: 1px solid ${balanceView.color}30; border-radius: 10px; padding: 10px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <i data-lucide="shield" style="width: 16px; height: 16px; color: ${balanceView.color};"></i>
              <div>
                <p style="color: white; font-size: 11px; font-weight: 600; margin: 0;">Current Balance</p>
                <p style="color: #9CA3AF; font-size: 9px; margin: 1px 0 0;">Registered by ${selectedTenant.name}</p>
              </div>
            </div>
            <span style="color: ${balanceView.color}; font-size: 10px; font-weight: 700;">${balanceView.label}</span>
          </div>
          
          <button id="btn-modal-notify-tenant" class="ep-btn-primary" style="padding: 10px; font-size: 12px;">
            <i data-lucide="send" style="width: 12px; height: 12px;"></i> Send Notice to Tenant
          </button>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="ep-screen">
      <div class="ep-dashboard">
        <!-- Header -->
        <div class="ep-dashboard-header">
          <div class="ep-header-profile">
            <div class="ep-header-avatar">
              <i data-lucide="wallet" style="width: 18px; height: 18px;"></i>
            </div>
            <div class="ep-header-info">
              <p class="ep-welcome">Estate Manager</p>
              <p class="ep-user-title">Greenview Estate</p>
            </div>
          </div>
          <button class="ep-header-btn danger" id="btn-manager-nav-logout">
            <i data-lucide="log-out" style="width: 16px; height: 16px;"></i>
          </button>
        </div>
        
        <!-- Scrollable content -->
        <div class="ep-dashboard-content">
          ${contentHtml}
        </div>
        
        <!-- Bottom Tab Navigation -->
        <div class="ep-bottom-nav" style="justify-content: space-evenly;">
          <button class="ep-bottom-nav-btn ${managerActiveTab === "overview" ? "active" : ""}" id="btn-manager-tab-overview">
            <i data-lucide="home" style="width: 16px; height: 16px;"></i>
            <span>Overview</span>
          </button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "tenants" ? "active" : ""}" id="btn-manager-tab-tenants">
            <i data-lucide="users" style="width: 16px; height: 16px;"></i>
            <span>Tenants</span>
          </button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "announcements" ? "active" : ""}" id="btn-manager-tab-announcements">
            <i data-lucide="megaphone" style="width: 16px; height: 16px;"></i>
            <span>Announce</span>
          </button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "notices" ? "active" : ""}" id="btn-manager-tab-notices">
            <i data-lucide="send" style="width: 16px; height: 16px;"></i>
            <span>Notices</span>
          </button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "reports" ? "active" : ""}" id="btn-manager-tab-reports">
            <i data-lucide="bar-chart-3" style="width: 16px; height: 16px;"></i>
            <span>Reports</span>
          </button>
        </div>
        
        <!-- Modal Overlay -->
        ${modalHtml}
      </div>
    </div>
  `;
}

// Global click event delegation handler.
//
// The phone's whole UI is re-rendered from scratch as an HTML string on every
// state change (see renderMobileApp()), so we can't attach individual
// listeners to buttons that don't exist yet at page-load time. Instead a
// single listener is bound once to the outer #mobile-app-root container
// (see the DOMContentLoaded block near the bottom of this file), and every
// click anywhere inside it bubbles up here. This function figures out which
// button/element was actually clicked, matches it against a big list of
// known element IDs/classes, mutates the relevant state variables, then
// calls renderMobileApp() to redraw the screen with the new state.
function handleMobileAppClick(e) {
  const target = e.target;
  
  // Find button or clickable element (bubble up to handle inner elements like text/icons).
  // Clicking an icon or text span inside a button still needs to resolve to
  // that button's id, hence the .closest() bubbling instead of a direct match.
  let btn = target.closest("button");
  if (!btn) {
    // Not a real <button> — check for the handful of non-button elements
    // that are also clickable (tag filters, list rows, bottom-nav items).
    const clickable = target.closest(".ep-tag-btn, .ep-item-card, .ep-bottom-nav-btn, .btn-manager-tenant-row");
    if (clickable) {
      btn = clickable;
    } else {
      // Click landed on inert content (plain text, background, etc.) — ignore it.
      return;
    }
  }
  
  const id = btn.id;
  
  // 1. Splash Screen clicks
  if (id === "btn-splash-get-started") {
    currentScreen = "auth";
    authRole = "tenant";
    authTab = "login";
    renderMobileApp();
    return;
  }
  if (id === "btn-splash-manager-login") {
    currentScreen = "auth";
    authRole = "manager";
    authTab = "login";
    renderMobileApp();
    return;
  }
  
  // 2. Auth Screen clicks
  if (id === "btn-auth-back") {
    currentScreen = "splash";
    renderMobileApp();
    return;
  }
  if (id === "btn-auth-tab-login") {
    authTab = "login";
    renderMobileApp();
    return;
  }
  if (id === "btn-auth-tab-register") {
    authTab = "register";
    renderMobileApp();
    return;
  }
  if (id === "btn-auth-toggle-pwd") {
    showPassword = !showPassword;
    renderMobileApp();
    return;
  }
  if (id === "btn-auth-toggle-confirm") {
    showConfirmPassword = !showConfirmPassword;
    renderMobileApp();
    return;
  }
  if (id === "btn-auth-proceed") {
    if (!authEmail) {
      alert("Please enter an email address.");
      return;
    }
    
    if (authRole === "manager") {
      activePhone = "+254787654321"; // Simulated manager phone
      
      if (db.tenants[activePhone]) {
        db.tenants[activePhone].role = "admin";
      } else {
        db.tenants[activePhone] = {
          fullName: "Estate Manager",
          role: "admin",
          verified: true,
          createdAt: new Date()
        };
      }
      
      currentScreen = "manager-dashboard";
      managerActiveTab = "overview";
      logSystemEvent("SYSTEM", `Estate Manager logged in successfully with email: ${authEmail}`);
      renderDbViewer();
      renderMobileApp();
    } else {
      if (authTab === "register") {
        if (!authFullName || !authPhone || !authPassword) {
          alert("Please fill in all registration fields.");
          return;
        }
        if (authPassword !== authConfirmPassword) {
          alert("Passwords do not match.");
          return;
        }
        activePhone = authPhone;
      } else {
        if (!authPhone) {
          alert("Please enter your phone number to login.");
          return;
        }
        activePhone = authPhone;
      }

      if (db.tenants[activePhone]?.verified) {
        setHouseNumberFromTenant(activePhone);
        currentScreen = "tenant-dashboard";
        tenantActiveTab = "home";
        renderMobileApp();
        return;
      }
      
      currentScreen = "house-entry";
      householdEntryStep = "search";
      renderMobileApp();
    }
    return;
  }
  
  // 3. House Entry clicks
  if (id === "btn-house-back") {
    currentScreen = "auth";
    renderMobileApp();
    return;
  }
  if (id === "btn-house-goto-search") {
    householdEntryStep = "search";
    renderMobileApp();
    return;
  }
  if (id === "btn-house-enter") {
    if (!registerEstateName) {
      alert("Please select an estate.");
      return;
    }
    if (!houseNumberInput) {
      alert("Please enter your house number.");
      return;
    }
    
    const match = findUnitByHouseNumber(houseNumberInput, registerEstateName);
    
    householdEntryStep = match ? "join" : "register";
    renderMobileApp();
    return;
  }
  if (id === "btn-house-join-invite") {
    if (!householdInviteInput) {
      alert("Please paste the household invite link.");
      return;
    }

    if (joinHouseholdFromInvite(householdInviteInput)) {
      currentScreen = "tenant-dashboard";
      tenantActiveTab = "home";
      renderDbViewer();
      renderMobileApp();
    }
    return;
  }
  if (id === "btn-house-register") {
    if (!houseNumberInput || !registerEstateName) {
      alert("Please select an estate and enter the house number.");
      return;
    }

    if (findUnitByHouseNumber(houseNumberInput, registerEstateName)) {
      alert(`House ${houseNumberInput} is already registered. Ask the first account for this house to send you the household invite link.`);
      householdEntryStep = "join";
      renderMobileApp();
      return;
    }
    
    const estateId = registerEstateName;
    
    const unitId = `unit-${Date.now()}`;
    if (!SEED_DATA.units[estateId]) {
      SEED_DATA.units[estateId] = {};
    }
    
    SEED_DATA.units[estateId][unitId] = {
      houseNumber: houseNumberInput,
      block: "Main",
      monthlyRate: 1500,
      occupied: true,
      currentTenantPhone: activePhone,
      householdOwnerPhone: activePhone,
      inviteToken: createHouseholdInviteToken(estateId, unitId)
    };

    db.tenants[activePhone] = {
      uid: "auth-user-" + Date.now(),
      fullName: authFullName || "Resident Tenant",
      estateId,
      unitId,
      role: "resident",
      verified: true,
      whatsappSessionState: { state: "MAIN_MENU", data: {} },
      createdAt: new Date(),
      lastActiveAt: new Date()
    };
    
    logSystemEvent("DATABASE", `Write: estates/${estateId}/units/${unitId} (Registered household)`, SEED_DATA.units[estateId][unitId]);
    logSystemEvent("DATABASE", `Write: tenants/${activePhone}`, db.tenants[activePhone]);
    
    currentScreen = "tenant-dashboard";
    tenantActiveTab = "home";
    renderDbViewer();
    renderMobileApp();
    return;
  }
  
  // 5. Tenant Dashboard clicks
  if (id === "btn-tenant-nav-notifications") {
    tenantActiveTab = "payments";
    renderMobileApp();
    return;
  }
  if (id === "btn-tenant-tab-home") {
    tenantActiveTab = "home";
    renderMobileApp();
    return;
  }
  if (id === "btn-tenant-tab-announcements") {
    tenantActiveTab = "announcements";
    renderMobileApp();
    return;
  }
  if (id === "btn-tenant-tab-pay") {
    tenantActiveTab = "payments";
    renderMobileApp();
    return;
  }
  if (id === "btn-tenant-tab-history") {
    tenantActiveTab = "history";
    renderMobileApp();
    return;
  }
  if (id === "btn-tenant-tab-profile") {
    tenantActiveTab = "profile";
    renderMobileApp();
    return;
  }
  if (id === "btn-send-household-link") {
    const household = getActiveTenantUnit();
    if (!household || household.unit.householdOwnerPhone !== activePhone) {
      alert("Only the first account that registered this house can send the household link.");
      return;
    }

    const inviteLink = getHouseholdInviteLink(household.unit);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteLink);
    }
    logSystemEvent("SYSTEM", `Household invite link sent by ${activePhone} for House ${household.unit.houseNumber}: ${inviteLink}`);
    alert("Household invite link copied. Send it to the person you want to add.");
    return;
  }
  if (id === "btn-tenant-pay-item" || id === "btn-action-pay" || id === "btn-payments-pay-now") {
    const bill = getActiveTenantBill();
    if (bill) {
      payingBillId = bill.id;
      renderMobileApp();
    }
    return;
  }
  if (id === "btn-action-history") {
    tenantActiveTab = "history";
    renderMobileApp();
    return;
  }
  if (id === "btn-close-payment-modal") {
    payingBillId = null;
    renderMobileApp();
    return;
  }
  if (id === "btn-confirm-payment-trigger") {
    if (payingBillId) {
      const inputEl = document.getElementById("input-payment-amount");
      const enteredAmt = inputEl ? parseFloat(inputEl.value) : 0;
      const bill = getActiveTenantBill();

      if (!enteredAmt || enteredAmt <= 0) {
        alert("Please enter a valid amount.");
        return;
      }

      apiInitiateStkPush(payingBillId, "app", enteredAmt);
      payingBillId = null;
      paymentAmountInput = "";
      showSuccessToast = true;
      successToastMessage = `M-Pesa STK Push for KSh ${enteredAmt.toLocaleString()} initiated. Check PIN prompt.`;
      setTimeout(() => {
        showSuccessToast = false;
        renderMobileApp();
      }, 3500);
      renderMobileApp();
    }
    return;
  }
  if (id === "btn-tenant-signout") {
    currentScreen = "splash";
    renderMobileApp();
    return;
  }
  
  // 6. Manager Dashboard clicks
  if (id === "btn-manager-nav-logout") {
    currentScreen = "splash";
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-tab-overview") {
    managerActiveTab = "overview";
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-tab-tenants") {
    managerActiveTab = "tenants";
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-tab-announcements") {
    managerActiveTab = "announcements";
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-tab-notices") {
    managerActiveTab = "notices";
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-tab-reports") {
    managerActiveTab = "reports";
    renderMobileApp();
    return;
  }
  if (btn.classList.contains("ep-tag-btn")) {
    const filter = btn.getAttribute("data-filter");
    if (filter) {
      managerFilterStatus = filter;
      renderMobileApp();
    }
    return;
  }
  if (btn.classList.contains("btn-manager-tenant-row")) {
    const tenantId = btn.getAttribute("data-id");
    const tenant = getTenantList().find(t => t.id === tenantId);
    if (tenant) {
      selectedTenant = tenant;
      renderMobileApp();
    }
    return;
  }
  if (id === "btn-close-tenant-modal") {
    selectedTenant = null;
    renderMobileApp();
    return;
  }
  if (id === "btn-modal-notify-tenant") {
    if (selectedTenant) {
      const tenantId = selectedTenant.id;
      selectedTenant = null;
      managerActiveTab = "notices";
      noticeTarget = tenantId;
      noticeText = "This is a reminder that your monthly security fee of KSh 1,500 is overdue. Please settle promptly.";
      renderMobileApp();
    }
    return;
  }
  if (btn.classList.contains("btn-manager-notify-tenant")) {
    const tenantId = btn.getAttribute("data-id");
    managerActiveTab = "notices";
    noticeTarget = tenantId;
    noticeText = "This is a reminder that your monthly security fee of KSh 1,500 is overdue. Please settle promptly.";
    renderMobileApp();
    return;
  }
  if (btn.classList.contains("btn-notice-template")) {
    const template = btn.getAttribute("data-template");
    noticeText = template;
    const txtArea = document.getElementById("textarea-notice-msg");
    if (txtArea) {
      txtArea.value = template;
    }
    return;
  }
  if (id === "btn-manager-post-announcement") {
    if (!managerAnnouncementTitle.trim() || !managerAnnouncementBody.trim()) {
      alert("Please fill in both a title and a message for the announcement.");
      return;
    }
    apiCreateAnnouncement(activePhone, managerAnnouncementTitle.trim(), managerAnnouncementBody.trim());
    managerAnnouncementTitle = "";
    managerAnnouncementBody = "";
    showAnnouncementSentToast = true;
    setTimeout(() => {
      showAnnouncementSentToast = false;
      renderMobileApp();
    }, 3000);
    renderMobileApp();
    return;
  }
  if (id === "btn-manager-send-notice") {
    if (!noticeText.trim()) {
      alert("Please compose a notice first.");
      return;
    }
    
    let targetLabel = "All Tenants";
    if (noticeTarget === "overdue") {
      targetLabel = "All Overdue Tenants";
    } else {
      const t = getTenantList().find(x => x.id === noticeTarget);
      if (t) {
        targetLabel = `${t.name} (House ${t.houseNo})`;
      }
    }
    
    logSystemEvent("SYSTEM", `WhatsApp Notice broadcasted to [${targetLabel}]: "${noticeText}"`);
    
    const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    sentNoticesList = [{ to: targetLabel, message: noticeText, date: dateStr }, ...sentNoticesList];
    
    noticeText = "";
    showNoticeSentToast = true;
    setTimeout(() => {
      showNoticeSentToast = false;
      renderMobileApp();
    }, 3000);
    
    renderMobileApp();
    return;
  }
}

// Global input handler
function handleMobileAppInput(e) {
  const id = e.target.id;
  const val = e.target.value;
  
  if (id === "input-auth-name") authFullName = val;
  if (id === "input-auth-email") authEmail = val;
  if (id === "input-auth-phone") authPhone = val;
  if (id === "input-auth-password") authPassword = val;
  if (id === "input-auth-confirm") authConfirmPassword = val;
  if (id === "input-house-number") houseNumberInput = val;
  if (id === "input-household-invite") householdInviteInput = val;
  if (id === "input-reg-estate") registerEstateName = val;
  if (id === "input-reg-house") houseNumberInput = val;
  if (id === "textarea-notice-msg") noticeText = val;
  if (id === "select-notice-target") noticeTarget = val;
  if (id === "input-payment-amount") paymentAmountInput = val;
  if (id === "input-ann-title") managerAnnouncementTitle = val;
  if (id === "textarea-ann-body") managerAnnouncementBody = val;
  
  if (id === "input-manager-search") {
    managerSearch = val;
    const query = val.toLowerCase();
    document.querySelectorAll(".btn-manager-tenant-row").forEach(row => {
      const text = row.innerText.toLowerCase();
      if (text.includes(query)) {
        row.style.display = "";
      } else {
        row.style.display = "none";
      }
    });
  }
  
}

// Global keydown handler
function handleMobileAppKeyDown(e) {
}

// Render the entire mobile app interface based on the active tab
function renderMobileApp() {
  const root = document.getElementById("mobile-app-root");
  
  if (currentScreen === "splash") {
    root.innerHTML = renderSplash();
  } else if (currentScreen === "auth") {
    root.innerHTML = renderAuth();
  } else if (currentScreen === "house-entry") {
    root.innerHTML = renderHouseEntry();
  } else if (currentScreen === "tenant-dashboard") {
    root.innerHTML = renderTenantDashboard();
  } else if (currentScreen === "manager-dashboard") {
    root.innerHTML = renderManagerDashboard();
  }
  
  lucide.createIcons();
}

// Initialise the WhatsApp bot chat interface panel
function initWhatsAppChat() {
  const container = document.getElementById("wa-chat-messages");
  container.innerHTML = "";
  
  // Appends initial welcome instructions from the WhatsApp channel bot
  appendWhatsAppBubble(
    `👋 *Welcome to EstatePay WhatsApp Portal!*\n\nThis channel is synchronized with your phone profile. Reply with *menu* or *0* to start.`, 
    "received"
  );
}

// Append bubble to WhatsApp chat area
function appendWhatsAppBubble(message, direction) {
  const container = document.getElementById("wa-chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `wa-bubble ${direction}`;
  
  const formattedMsg = message
    .replace(/\*(.*?)\*/g, "<strong>$1</strong>") // bold formatting
    .replace(/_(.*?)_/g, "<em>$1</em>")          // italics
    .replace(/\n/g, "<br>");                      // lines
    
  bubble.innerHTML = `
    ${formattedMsg}
    <span class="wa-bubble-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// Trigger Lipa na M-Pesa PIN USSD Prompt Mockup
function triggerMpesaUSSD(checkoutRequestId, amount, phone, billId) {
  pendingMpesaCheckout = { checkoutRequestId, amount, phone, billId };
  
  document.getElementById("ussd-prompt-text").innerHTML = `
    Lipa na M-Pesa:<br>
    Pay <strong>KES ${amount.toLocaleString()}</strong> to <strong>EstatePay</strong> for Unit ${db.bills[billId].unitId}?
  `;
  document.getElementById("ussd-pin").value = "";
  document.getElementById("ussd-error-msg").innerText = "";
  document.getElementById("mpesa-ussd-dialog").style.display = "flex";
  
  logSystemEvent("SYSTEM", `USSD Handset Simulator triggered for ${phone} - STK PIN Prompt active`);
}

// Close Lipa Na M-Pesa prompt UI
function closeMpesaUSSD(success = false, pin = "") {
  document.getElementById("mpesa-ussd-dialog").style.display = "none";
  if (pendingMpesaCheckout) {
    apiMpesaCallback(pendingMpesaCheckout.checkoutRequestId, pin, success);
    pendingMpesaCheckout = null;
  }
}

// Render JSON tables in the Firestore Visualizer panel
function renderDbViewer() {
  const container = document.getElementById("db-docs-container");
  container.innerHTML = "";
  renderAdminRegisteredHouses();

  // Check if viewing sub-collection
  let targetColl = activeDbCollection;
  let items = db[targetColl];

  if (!items || Object.keys(items).length === 0) {
    container.innerHTML = `<div class="db-doc-empty">Collection "${targetColl}" is empty.</div>`;
    return;
  }

  Object.keys(items).forEach(id => {
    const docRow = document.createElement("div");
    docRow.className = "db-doc-row";
    
    // Beautify details output (stripping cyclic references, functions, etc.)
    const docDetails = JSON.stringify(items[id], (key, value) => {
      if (key === "whatsappSessionState" && value) return `{ state: "${value.state}", data: ... }`;
      if (value instanceof Date) return value.toISOString();
      return value;
    }, 2);

    docRow.innerHTML = `
      <div class="db-doc-id" title="${id}">${id}</div>
      <pre class="db-doc-fields">${docDetails}</pre>
    `;
    container.appendChild(docRow);
  });
}

// Populates the Admin Control Center's "Registered Houses" list in the (hidden) admin panel from live simulated-DB data.
function renderAdminRegisteredHouses() {
  const container = document.getElementById("admin-registered-houses-list");
  if (!container) return;

  const houses = getTenantList();
  if (!houses.length) {
    container.innerHTML = `<div class="admin-house-empty">No registered houses yet.</div>`;
    return;
  }

  container.innerHTML = houses.map(house => {
    const balanceView = getBalanceDisplay(house.balance);
    return `
      <div class="admin-house-row">
        <span class="admin-house-no">House ${house.houseNo}</span>
        <span class="admin-house-name">${house.name}</span>
        <span class="admin-house-balance" style="color: ${balanceView.color};">${balanceView.label}</span>
      </div>
    `;
  }).join("");
}

// ==========================================================================
// 6. Event Listeners and Setup
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  // Reset database to seed data
  resetDatabase();
  const incomingInviteToken = new URL(window.location.href).searchParams.get("householdInvite");
  if (incomingInviteToken) {
    householdInviteInput = getHouseholdInviteLink(findUnitByInviteToken(incomingInviteToken)?.unit) || incomingInviteToken;
  }

  // Tab bindings for devices panel
  document.getElementById("toggle-ff").addEventListener("click", (e) => {
    document.getElementById("toggle-ff").classList.add("active");
    document.getElementById("toggle-wa").classList.remove("active");
    document.getElementById("device-mobile-app").classList.remove("hidden");
    document.getElementById("device-whatsapp").classList.add("hidden");
  });

  document.getElementById("toggle-wa").addEventListener("click", (e) => {
    document.getElementById("toggle-wa").classList.add("active");
    document.getElementById("toggle-ff").classList.remove("active");
    document.getElementById("device-whatsapp").classList.remove("hidden");
    document.getElementById("device-mobile-app").classList.add("hidden");
  });

  // Mobile App delegated event listeners (screen state-machine)
  const mobileRoot = document.getElementById("mobile-app-root");
  mobileRoot.addEventListener("click", handleMobileAppClick);
  mobileRoot.addEventListener("input", handleMobileAppInput);
  mobileRoot.addEventListener("keydown", handleMobileAppKeyDown);

  // WhatsApp sender listener
  document.getElementById("wa-send-btn").addEventListener("click", () => {
    const input = document.getElementById("wa-message-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendWhatsAppUserMessage(text);
  });

  document.getElementById("wa-message-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("wa-send-btn").click();
    }
  });

  // Lipa Na M-pesa Dialog handlers
  document.getElementById("btn-ussd-send").addEventListener("click", () => {
    const pin = document.getElementById("ussd-pin").value;
    if (pin.length !== 4) {
      document.getElementById("ussd-error-msg").innerText = "PIN must be 4 digits.";
      return;
    }
    closeMpesaUSSD(true, pin);
  });

  document.getElementById("btn-ussd-cancel").addEventListener("click", () => {
    closeMpesaUSSD(false);
  });
  
  document.getElementById("btn-ussd-cancel-header").addEventListener("click", () => {
    closeMpesaUSSD(false);
  });

  // DB View Tabs bindings
  document.querySelectorAll(".db-tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".db-tab-btn").forEach(b => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      activeDbCollection = e.currentTarget.getAttribute("data-collection");
      renderDbViewer();
    });
  });

  // Admin triggers
  document.getElementById("admin-btn-trigger-billing").addEventListener("click", () => {
    apiGenerateMonthlyBills();
  });

  // Admin set role claims switcher
  document.getElementById("admin-select-role").addEventListener("change", (e) => {
    const newRole = e.target.value;
    
    // Read active user
    const tenant = db.tenants[activePhone];
    if (tenant) {
      tenant.role = newRole;
      logSystemEvent("DATABASE", `Update: tenants/${activePhone} (Admin claims override)`, { role: newRole });
      logSystemEvent("SYSTEM", `Custom Claims Token updated on client. Claim: { role: "${newRole}" }`);
      renderDbViewer();
      renderMobileApp();
    } else {
      alert("No active logged-in profile. Onboard via the mobile app mockup first.");
    }
  });

  // Reset database button
  document.getElementById("btn-reset-db").addEventListener("click", () => {
    if (confirm("Reset simulated database to seed state?")) {
      resetDatabase();
    }
  });

  // Clear log screen
  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    document.getElementById("system-logs").innerHTML = "";
  });

  // Phone time ticker
  setInterval(() => {
    const timeSpan = document.getElementById("mobile-time");
    if (timeSpan) {
      const now = new Date();
      timeSpan.innerText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  }, 1000);

  // Initialize Lucide Icons
  lucide.createIcons();
});

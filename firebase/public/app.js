/**
 * EstatePay — PRODUCTION frontend.
 * Same visual design/CSS classes as the simulator, but every data operation
 * here is real: Firebase Phone Auth, live Firestore listeners, and Cloud
 * Functions calls (no more in-memory fake `db`).
 *
 * SETUP REQUIRED BEFORE THIS WORKS:
 * 1. Replace FIREBASE_CONFIG below with your real Firebase project config
 *    (Firebase Console > Project Settings > General > Your apps > Web app).
 * 2. Enable Phone Authentication in Firebase Console > Authentication > Sign-in method.
 * 3. Add your hosting domain to Authentication > Settings > Authorized domains.
 * 4. Deploy the Cloud Functions in /functions first, so these calls resolve.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, connectAuthEmulator, RecaptchaVerifier, signInWithPhoneNumber, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, EmailAuthProvider, linkWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, onSnapshot, collection, query, where, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// ==========================================================================
// 1. Firebase Init — REPLACE with your real project config
//    (Even when running against local emulators, this config object still
//    needs a real projectId — the emulators use it to know which project's
//    data to simulate. apiKey/appId can stay as placeholders for emulator-only
//    testing, but projectId MUST match your actual Firebase project.)
// ==========================================================================
// ==========================================================================
// WhatsApp bot number — this is Twilio's shared Sandbox number by default.
// Once you have a real approved WhatsApp sender, replace this with that
// number (E.164, digits only, no "+").
// ==========================================================================
const WHATSAPP_BOT_NUMBER = "14155238886"; // Update after Meta setup

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCmmhTApZ66vDtO5TSZyCCJK7Vi2XIVOwQ",
  authDomain: "estate-pay-232f6.firebaseapp.com",
  projectId: "estate-pay-232f6",
  storageBucket: "estate-pay-232f6.firebasestorage.app",
  messagingSenderId: "166144521084",
  appId: "1:166144521084:web:8e3bad865a7000b8e2aaf9",
};

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const dbFs = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp);

// --------------------------------------------------------------------------
// Auto-connect to local Firebase Emulators when running on localhost/127.0.0.1
// so hosting + auth + firestore + functions all run together as one app,
// with no real credentials or deployment needed yet.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Auto-connect to local Firebase Emulators when running on localhost/127.0.0.1.
// FUNCTIONS_ONLY = true lets you keep real Auth + real Firestore (your actual
// Firebase project) while running Cloud Functions locally on your own machine
// — useful if you can't deploy 2nd-gen Functions yet (requires Blaze plan)
// but still want to test real signups against real data.
// Set FUNCTIONS_ONLY = false once you're ready to test fully offline instead.
// --------------------------------------------------------------------------
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const FUNCTIONS_ONLY = true;
if (isLocal) {
  console.log("🔧 Running against local Functions emulator" + (FUNCTIONS_ONLY ? " (Auth/Firestore still REAL)" : " (all local)"));
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  if (!FUNCTIONS_ONLY) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(dbFs, "127.0.0.1", 8080);
  }
}

const callResolveIdentity = httpsCallable(functions, "resolveIdentity");
const callRegisterHousehold = httpsCallable(functions, "registerHousehold");
const callGenerateInvite = httpsCallable(functions, "generateHouseholdInvite");
const callRedeemInvite = httpsCallable(functions, "redeemHouseholdInvite");
const callInitiateStkPush = httpsCallable(functions, "initiateStkPush");
const callCreateAnnouncement = httpsCallable(functions, "createAnnouncement");
const callCreateDiscussionPost = httpsCallable(functions, "createDiscussionPost");
const callRunBillingNow = httpsCallable(functions, "runBillingNow");

// ==========================================================================
// 2. App State
// ==========================================================================
// Synchronously read cached session on boot to avoid flash of splash screen
const cachedRole = localStorage.getItem("estatepay_cached_role");
let currentScreen = cachedRole === "manager" ? "manager-dashboard" : (cachedRole === "tenant" ? "tenant-dashboard" : "splash");
let authChecking = !cachedRole; // false on startup if cached role exists, otherwise true to check auth status

let authRole = "tenant";            // tenant | manager
let authPhone = "";
let authFullName = "";
let authMode = "login";             // login | signup — which tab is active on the auth screen
let authPassword = "";
let authConfirmPassword = "";
let loginLoading = false;           // true while signInWithEmailAndPassword is in flight
let otpCode = "";
let confirmationResult = null;      // Firebase phone auth confirmation handle
let recaptchaVerifier = null;

let currentUser = null;             // Firebase Auth user
let tenantDoc = null;               // live tenants/{phone} doc
let unitDoc = null;                 // live unit doc for tenant's house
let activeBill = null;              // live current bill for tenant
let paymentHistory = [];            // live transactions for tenant
let announcements = [];             // live announcements for tenant's estate

let houseNumberInput = "";
let householdInviteInput = "";
let householdEntryStep = "search";  // search | join | register
let registerEstateId = "";
let estatesCache = [];              // {id, name} list loaded once for the dropdown

let tenantActiveTab = "home";       // home | announcements | payments | history | profile
let managerActiveTab = "overview";  // overview | tenants | notices | reports
let managerTenants = [];            // live list of tenants for the manager's estate
let managerUnits = [];              // live list of units for the manager's estate
let managerBills = [];              // live list of bills for the manager's estate
let householdMembers = [];          // live list of other tenants sharing the same unit

let payingBillId = null;            // non-null when the payment modal is open
let paymentAmountInput = "";
let managerSearch = "";
let managerFilterStatus = "all";    // all | pending | paid

let payingAmount = "";
let toastMessage = null;
let unsubscribers = [];             // active onSnapshot() unsubscribe functions, cleared on screen change

// ==========================================================================
// 3. Auth flow
// ==========================================================================

/** Converts a phone number to a pseudo-email for Firebase email/password auth. */
function pseudoEmail(phone) {
  // Strip leading + and whitespace, e.g. "+254712345678" -> "254712345678@estatepay.app"
  return phone.replace(/^\+/, "").replace(/\s/g, "") + "@estatepay.app";
}

function ensureRecaptcha() {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
  return recaptchaVerifier;
}

async function sendOtp(phoneE164) {
  const verifier = ensureRecaptcha();
  confirmationResult = await signInWithPhoneNumber(auth, phoneE164, verifier);
}

async function confirmOtp(code) {
  const result = await confirmationResult.confirm(code);
  return result.user;
}

/**
 * Login with phone number + password (returning users).
 * Uses the pseudo-email trick: +254712345678 -> 254712345678@estatepay.app
 */
async function handleLogin() {
  if (!authPhone) { showToast("Please enter your phone number."); return; }
  if (!authPassword) { showToast("Please enter your password."); return; }
  loginLoading = true;
  renderApp();
  try {
    await signInWithEmailAndPassword(auth, pseudoEmail(authPhone), authPassword);
    // onAuthStateChanged fires and routes to the correct dashboard.
  } catch (err) {
    loginLoading = false;
    if (err.code === "auth/user-not-found" || err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
      showToast("Incorrect phone number or password.");
    } else {
      showToast(err.message || "Login failed. Please try again.");
    }
    renderApp();
  }
}

/**
 * After OTP is confirmed for a new user, set a password by linking
 * an email/password credential to the phone-auth account.
 */
async function handleSetPassword() {
  if (authPassword.length < 6) { showToast("Password must be at least 6 characters."); return; }
  if (authPassword !== authConfirmPassword) { showToast("Passwords don't match."); return; }
  try {
    const credential = EmailAuthProvider.credential(pseudoEmail(authPhone), authPassword);
    await linkWithCredential(currentUser, credential);
    // Password linked — now send the user to house entry to finish setup.
    currentScreen = "house-entry";
    householdEntryStep = "search";
    await loadEstatesOnce();
    authPassword = "";
    authConfirmPassword = "";
    renderApp();
  } catch (err) {
    if (err.code === "auth/provider-already-linked" || err.code === "auth/email-already-in-use") {
      // Password already set (e.g. re-registered) — just proceed to house entry.
      currentScreen = "house-entry";
      householdEntryStep = "search";
      await loadEstatesOnce();
      renderApp();
    } else {
      showToast(err.message || "Could not set password. Please try again.");
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  loginLoading = false;

  if (!user) {
    authChecking = false;
    localStorage.removeItem("estatepay_cached_role");
    if (currentScreen !== "auth" && currentScreen !== "otp" && currentScreen !== "set-password") {
      currentScreen = "splash";
      renderApp();
    }
    return;
  }

  // If the user just confirmed an OTP (new signup path) and we're waiting
  // for them to set a password, don't do resolveIdentity yet — stay on set-password.
  if (currentScreen === "otp") {
    authChecking = false;
    currentScreen = "set-password";
    authPassword = "";
    authConfirmPassword = "";
    renderApp();
    return;
  }

  // Already past set-password — don't re-trigger routing.
  if (currentScreen === "set-password") {
    authChecking = false;
    return;
  }

  try {
    // Always resolve role from Firestore via resolveIdentity.
    // Custom claims can be stale (e.g. a former tenant promoted to admin in the
    // console) so we never trust them for routing. The localStorage cache above
    // handles the instant visual rendering; resolveIdentity handles correctness.
    const { data } = await callResolveIdentity({});
    authChecking = false;
    if (data.exists) {
      const role = data.tenant.role;
      const isManager = role === "admin" || role === "committee";
      localStorage.setItem("estatepay_cached_role", isManager ? "manager" : "tenant");

      if (isManager) {
        currentScreen = "manager-dashboard";
        managerActiveTab = "overview";
        subscribeManagerDashboard(data.tenant.estateId);
      } else {
        currentScreen = "tenant-dashboard";
        tenantActiveTab = "home";
        const tenantPhone = data.tenant.phone || user.phoneNumber;
        authPhone = tenantPhone || authPhone;
        subscribeTenantDashboard(tenantPhone);
      }
    } else {
      localStorage.removeItem("estatepay_cached_role");
      currentScreen = "house-entry";
      householdEntryStep = "search";
      await loadEstatesOnce();
    }
    renderApp();
  } catch (err) {
    authChecking = false;
    localStorage.removeItem("estatepay_cached_role");
    console.error("resolveIdentity failed:", err);
    showToast("Something went wrong loading your account. Please try again.");
    currentScreen = "splash";
    renderApp();
  }
});

// ==========================================================================
// 4. Firestore live subscriptions
// ==========================================================================
let activeSubscribedEstateId = null;
let activeSubscribedUnitId = null;
let unitSubUnsubs = [];
let annSubUnsubs = [];

function clearUnitSubscriptions() {
  unitSubUnsubs.forEach((unsub) => unsub());
  unitSubUnsubs = [];
  activeSubscribedUnitId = null;
}

function clearAnnouncementsSubscriptions() {
  annSubUnsubs.forEach((unsub) => unsub());
  annSubUnsubs = [];
  activeSubscribedEstateId = null;
}

function clearSubscriptions() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  clearUnitSubscriptions();
  clearAnnouncementsSubscriptions();
}

async function loadEstatesOnce() {
  const snap = await getDocs(collection(dbFs, "estates"));
  estatesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function subscribeTenantDashboard(phone) {
  clearSubscriptions();

  const tenantUnsub = onSnapshot(doc(dbFs, "tenants", phone), async (snap) => {
    tenantDoc = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (tenantDoc?.estateId && tenantDoc?.unitId) {
      if (tenantDoc.estateId !== activeSubscribedEstateId) {
        subscribeAnnouncements(tenantDoc.estateId);
      }
      if (tenantDoc.unitId !== activeSubscribedUnitId) {
        subscribeUnit(tenantDoc.estateId, tenantDoc.unitId);
      }
    }
    renderApp();
  });
  unsubscribers.push(tenantUnsub);

  const billQuery = query(
    collection(dbFs, "bills"),
    where("tenantPhone", "==", phone),
    orderBy("generatedAt", "desc"),
    limit(1)
  );
  const billUnsub = onSnapshot(billQuery, (snap) => {
    activeBill = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    renderApp();
  });
  unsubscribers.push(billUnsub);

  const txnQuery = query(
    collection(dbFs, "transactions"),
    where("tenantPhone", "==", phone),
    orderBy("initiatedAt", "desc"),
    limit(20)
  );
  const txnUnsub = onSnapshot(txnQuery, (snap) => {
    paymentHistory = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (currentScreen === "tenant-dashboard") renderApp();
  });
  unsubscribers.push(txnUnsub);
}

function subscribeUnit(estateId, unitId) {
  clearUnitSubscriptions();
  activeSubscribedUnitId = unitId;

  const unitUnsub = onSnapshot(doc(dbFs, "estates", estateId, "units", unitId), (snap) => {
    unitDoc = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    renderApp();
  });
  unitSubUnsubs.push(unitUnsub);

  const membersQuery = query(
    collection(dbFs, "tenants"),
    where("estateId", "==", estateId),
    where("unitId", "==", unitId)
  );
  const membersUnsub = onSnapshot(membersQuery, (snap) => {
    householdMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (currentScreen === "tenant-dashboard") renderApp();
  });
  unitSubUnsubs.push(membersUnsub);
}

function subscribeAnnouncements(estateId) {
  clearAnnouncementsSubscriptions();
  activeSubscribedEstateId = estateId;

  const annQuery = query(
    collection(dbFs, "forum_announcements"),
    where("estateId", "==", estateId),
    orderBy("createdAt", "desc"),
    limit(10)
  );
  const annUnsub = onSnapshot(annQuery, (snap) => {
    announcements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (currentScreen === "tenant-dashboard" || currentScreen === "manager-dashboard") renderApp();
  });
  annSubUnsubs.push(annUnsub);
}

function subscribeManagerDashboard(estateId) {
  clearSubscriptions();

  const tenantsUnsub = onSnapshot(
    query(collection(dbFs, "tenants"), where("estateId", "==", estateId)),
    (snap) => {
      managerTenants = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderApp();
    }
  );
  unsubscribers.push(tenantsUnsub);

  const unitsUnsub = onSnapshot(
    collection(dbFs, "estates", estateId, "units"),
    (snap) => {
      managerUnits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderApp();
    }
  );
  unsubscribers.push(unitsUnsub);

  const billsUnsub = onSnapshot(
    query(collection(dbFs, "bills"), where("estateId", "==", estateId)),
    (snap) => {
      managerBills = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderApp();
    }
  );
  unsubscribers.push(billsUnsub);

  subscribeAnnouncements(estateId);
}

// ==========================================================================
// 5. Actions (call Cloud Functions)
// ==========================================================================
function extractInviteToken(value) {
  const match = value.match(/householdInvite=([^&\s]+)/);
  return match ? match[1] : value.trim();
}

async function handleRegisterHousehold() {
  if (!registerEstateId) { showToast("Please select your estate first."); return; }
  if (!houseNumberInput.trim()) { showToast("Please enter your house number."); return; }
  try {
    await callRegisterHousehold({
      estateId: registerEstateId,
      houseNumber: houseNumberInput.trim(),
      fullName: authFullName,
    });
    await currentUser.getIdToken(true); // pick up the freshly-set custom claims
    showToast("House registered! Welcome to EstatePay.");
    currentScreen = "tenant-dashboard";
    // authPhone is set during OTP signup or login. currentUser.phoneNumber is
    // null when signed in via email/password (the pseudo-email trick).
    const phone = authPhone || currentUser.phoneNumber;
    subscribeTenantDashboard(phone);
    renderApp();
  } catch (err) {
    if (err.code === "functions/already-exists") {
      householdEntryStep = "join";
      renderApp();
      return;
    }
    showToast(err.message || "Could not register household.");
  }
}

async function handleJoinWithInvite() {
  try {
    const token = extractInviteToken(householdInviteInput);
    await callRedeemInvite({ token, fullName: authFullName });
    await currentUser.getIdToken(true); // pick up the freshly-set custom claims
    showToast("You've joined your household!");
    currentScreen = "tenant-dashboard";
    const phone = authPhone || currentUser.phoneNumber;
    subscribeTenantDashboard(phone);
    renderApp();
  } catch (err) {
    showToast(err.message || "That invite link didn't work.");
  }
}

async function handleGenerateInvite() {
  try {
    const { data } = await callGenerateInvite({ estateId: tenantDoc.estateId, unitId: tenantDoc.unitId });
    const link = `${window.location.origin}/?householdInvite=${data.inviteToken}`;
    await navigator.clipboard.writeText(link).catch(() => {});
    showToast("Invite link copied to clipboard!");
  } catch (err) {
    showToast(err.message || "Could not generate invite link.");
  }
}

function getBalanceDisplay(balance) {
  if (balance > 0) return { label: `KSh ${balance.toLocaleString()}`, color: "#EF4444" };
  if (balance < 0) return { label: `+KSh ${Math.abs(balance).toLocaleString()}`, color: "#10B981" };
  return { label: "KSh 0", color: "#60A5FA" };
}

async function handlePayNow(amount) {
  if (!activeBill) return;
  try {
    showToast("Sending M-Pesa prompt to your phone...");
    await callInitiateStkPush({ billId: activeBill.id, payAmount: amount || null });
    payingBillId = null;
    paymentAmountInput = "";
    showToast("Check your phone for the M-Pesa PIN prompt.");
  } catch (err) {
    showToast(err.message || "Could not start payment.");
  }
}

async function handlePostAnnouncement(title, body) {
  try {
    await callCreateAnnouncement({ title, body, pinned: false });
    showToast("Announcement posted.");
  } catch (err) {
    showToast(err.message || "Could not post announcement.");
  }
}

async function handlePostDiscussion(title, body) {
  try {
    await callCreateDiscussionPost({ title, body });
    showToast("Posted to the forum.");
  } catch (err) {
    showToast(err.message || "Could not post.");
  }
}

async function handleRunBilling() {
  try {
    const { data } = await callRunBillingNow({});
    showToast(`Billing run complete — ${data.generatedCount} bill(s) generated.`);
  } catch (err) {
    showToast(err.message || "Could not run billing.");
  }
}

function showToast(message) {
  toastMessage = message;
  renderApp();
  setTimeout(() => {
    toastMessage = null;
    renderApp();
  }, 3500);
}

// ==========================================================================
// 6. Screen renderers (visual markup kept identical to the simulator so the
//    existing style.css classes apply unchanged)
// ==========================================================================
function renderSplash() {
  let actionsHtml = `
    <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 240px;">
      <button id="btn-splash-get-started" class="ep-btn-primary">Get Started</button>
    </div>
  `;

  if (authChecking) {
    actionsHtml = `
      <div style="display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 240px; color: #9CA3AF; font-size: 13px; margin-top: 10px;">
        <div class="ep-spinner"></div>
        <span>Authenticating...</span>
      </div>
    `;
  }

  return `
    <div class="ep-splash-bg">
      <div class="ep-logo-wrapper">
        <i data-lucide="wallet" style="width: 40px; height: 40px; color: white;"></i>
      </div>
      <div class="ep-splash-title">ESTATEPAY</div>
      <div class="ep-splash-subtitle">Smart household payments simplified</div>
      ${actionsHtml}
    </div>
    <div id="recaptcha-container"></div>
  `;
}

function renderAuth() {
  const isLogin = authMode === "login";

  const loginForm = `
    <div style="display: flex; flex-direction: column; gap: 14px;">
      <div class="ep-input-wrapper">
        <i data-lucide="phone" class="ep-input-icon"></i>
        <input type="tel" id="input-auth-phone" class="ep-input ep-input-icon-pad"
          placeholder="Phone e.g. +2547XXXXXXXX" value="${authPhone}" autocomplete="tel">
      </div>
      <div class="ep-input-wrapper">
        <i data-lucide="lock" class="ep-input-icon"></i>
        <input type="password" id="input-auth-password" class="ep-input ep-input-icon-pad"
          placeholder="Password" value="${authPassword}" autocomplete="current-password">
        <button id="btn-toggle-pw" class="ep-input-eye" type="button" tabindex="-1">
          <i data-lucide="eye" style="width:16px;height:16px;"></i>
        </button>
      </div>
      ${loginLoading
        ? `<div style="display:flex;justify-content:center;margin-top:8px;"><div class="ep-spinner"></div></div>`
        : `<button id="btn-auth-login" class="ep-btn-primary" style="margin-top: 8px;">Login</button>`
      }
    </div>
  `;

  const signupForm = `
    <div style="display: flex; flex-direction: column; gap: 14px;">
      <div class="ep-input-wrapper">
        <i data-lucide="user" class="ep-input-icon"></i>
        <input type="text" id="input-auth-name" class="ep-input ep-input-icon-pad"
          placeholder="Full Name" value="${authFullName}" autocomplete="name">
      </div>
      <div class="ep-input-wrapper">
        <i data-lucide="phone" class="ep-input-icon"></i>
        <input type="tel" id="input-auth-phone" class="ep-input ep-input-icon-pad"
          placeholder="Phone e.g. +2547XXXXXXXX" value="${authPhone}" autocomplete="tel">
      </div>
      <button id="btn-auth-send-otp" class="ep-btn-primary" style="margin-top: 8px;">Send Verification Code</button>
    </div>
  `;

  return `
    <div class="ep-screen">
      <div class="ep-container">
        <button id="btn-auth-back" class="ep-back-btn">
          <i data-lucide="arrow-left" style="width: 20px; height: 20px;"></i>
        </button>

        <div style="display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 28px;">
          <div class="ep-logo-wrapper-sm">
            <i data-lucide="wallet" style="width: 28px; height: 28px; color: white;"></i>
          </div>
          <h1 style="color: white; font-size: 18px; font-weight: 800; letter-spacing: 0.25em;">ESTATEPAY</h1>
          <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
            ${isLogin ? "Welcome back" : "Create your account"}
          </p>
        </div>

        <!-- Tab switcher -->
        <div class="ep-auth-tabs">
          <button id="btn-tab-login" class="ep-tab-btn ${isLogin ? 'active' : ''}">
            <i data-lucide="log-in" style="width:14px;height:14px;"></i> Login
          </button>
          <button id="btn-tab-signup" class="ep-tab-btn ${!isLogin ? 'active' : ''}">
            <i data-lucide="user-plus" style="width:14px;height:14px;"></i> Sign Up
          </button>
        </div>

        <div style="margin-top: 24px;">
          ${isLogin ? loginForm : signupForm}
        </div>

        <div id="recaptcha-container" style="margin-top: 12px;"></div>
      </div>
    </div>
  `;
}

function renderSetPassword() {
  return `
    <div class="ep-screen">
      <div class="ep-container">
        <div style="display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 28px;">
          <div class="ep-logo-wrapper-sm" style="background: linear-gradient(135deg, #10B981, #059669);">
            <i data-lucide="shield-check" style="width: 28px; height: 28px; color: white;"></i>
          </div>
          <h1 style="color: white; font-size: 16px; font-weight: 800;">Create a Password</h1>
          <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0; line-height: 1.5;">
            Set a password so you can log in quickly next time — no OTP needed.
          </p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 14px;">
          <div class="ep-input-wrapper">
            <i data-lucide="lock" class="ep-input-icon"></i>
            <input type="password" id="input-set-password" class="ep-input ep-input-icon-pad"
              placeholder="New password (min 6 chars)" value="${authPassword}" autocomplete="new-password">
          </div>
          <div class="ep-input-wrapper">
            <i data-lucide="lock" class="ep-input-icon"></i>
            <input type="password" id="input-confirm-password" class="ep-input ep-input-icon-pad"
              placeholder="Confirm password" value="${authConfirmPassword}" autocomplete="new-password">
          </div>
          <button id="btn-set-password" class="ep-btn-primary" style="margin-top: 8px;">
            Set Up Account
          </button>
          <button id="btn-skip-password" style="background: transparent; border: none; color: #6B7280; font-size: 12px; cursor: pointer; padding: 4px;">
            Skip for now
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderOtp() {
  return `
    <div class="ep-screen">
      <div class="ep-container">
        <button id="btn-otp-back" class="ep-back-btn">
          <i data-lucide="arrow-left" style="width: 20px; height: 20px;"></i>
        </button>
        <h1 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 16px;">Enter the code we texted you</h1>
        <input type="text" id="input-otp-code" class="ep-input" placeholder="6-digit code" value="${otpCode}" inputmode="numeric" maxlength="6">
        <button id="btn-otp-confirm" class="ep-btn-primary" style="margin-top: 24px;">Verify & Continue</button>
      </div>
    </div>
  `;
}

function renderHouseEntry() {
  const estateOptions = estatesCache
    .map((e) => `<option value="${e.id}" ${registerEstateId === e.id ? "selected" : ""}>${e.name}</option>`)
    .join("");

  return `
    <div class="ep-screen">
      <div class="ep-container">
        <button id="btn-house-back" class="ep-back-btn">
          <i data-lucide="arrow-left" style="width: 20px; height: 20px;"></i>
        </button>
        <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 32px;">
          <div class="ep-logo-wrapper-sm" style="width: 64px; height: 64px; border-radius: 14px;">
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
            <button id="btn-house-register" class="ep-btn-primary">Register This House</button>
          </div>
        ` : ""}

        ${householdEntryStep === "join" ? `
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <h2 style="color: white; text-align: center; font-size: 14px;">Join Existing Household</h2>
            <div style="background: #111827; border: 1px solid #253044; border-radius: 8px; padding: 9px 10px; color: #9CA3AF; font-size: 10px; line-height: 1.4;">
              This house is already registered. Ask the household owner for the invite link.
            </div>
            <input type="text" id="input-household-invite" class="ep-input" placeholder="Paste Household Invite Link" value="${householdInviteInput}">
            <button id="btn-house-join-invite" class="ep-btn-primary" style="background: #10B981;">Join With Invite Link</button>
            <button id="btn-house-goto-search" style="background: transparent; border: none; color: #60A5FA; font-size: 12px; cursor: pointer; margin-top: 12px;">Back to search</button>
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

function renderTenantDashboard() {
  const balance = activeBill ? activeBill.balance : 0;
  const amountPaid = activeBill ? (activeBill.amountPaid || 0) : 0;
  const isDue = balance > 0;
  const isPartial = activeBill && balance > 0 && amountPaid > 0;
  const balanceView = getBalanceDisplay(balance);
  const statusInfo = !isDue
    ? { label: balance < 0 ? "Credit" : "Paid", color: balanceView.color, bg: `${balanceView.color}22`, icon: "check-circle-2" }
    : { label: "Unpaid", color: "#EF4444", bg: "#EF444422", icon: "clock" };
  const isOwner = unitDoc && currentUser && unitDoc.householdOwnerPhone === currentUser.phoneNumber;
  const houseLabel = unitDoc?.houseNumber || "-";

  let contentHtml = "";

  if (tenantActiveTab === "home") {
    const totalAmt = activeBill ? activeBill.amount : 0;
    const paidPct = totalAmt > 0 ? Math.round((amountPaid / totalAmt) * 100) : 0;
    const partialBar = isPartial ? `
      <div style="margin-top: 10px;">
        <div style="display: flex; justify-content: space-between; font-size: 9px; margin-bottom: 3px;">
          <span style="color: #90CAF9;">Paid so far</span>
          <span style="color: #fff; font-weight: 700;">KSh ${amountPaid.toLocaleString()} / ${totalAmt.toLocaleString()}</span>
        </div>
        <div style="height: 4px; background: rgba(255,255,255,0.15); border-radius: 999px; overflow: hidden;">
          <div style="width: ${paidPct}%; height: 100%; background: #60A5FA; border-radius: 999px;"></div>
        </div>
      </div>` : "";

    contentHtml = `
      <div class="ep-balance-card">
        <span class="ep-balance-label">Security Fee — ${activeBill ? activeBill.period : "No active bill"}</span>
        <span class="ep-balance-val" style="color: ${balanceView.color};">${balanceView.label}</span>
        <div class="ep-balance-footer">
          <div>
            <span style="color: #90CAF9; font-size: 9px; display: block;">Due Date</span>
            <span style="color: #fff; font-size: 11px; font-weight: 600;">${activeBill?.dueDate?.toDate ? activeBill.dueDate.toDate().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "-"}</span>
          </div>
          <span class="ep-status-badge" style="background: ${statusInfo.bg}; color: ${statusInfo.color};">
            <i data-lucide="${statusInfo.icon}" style="width: 12px; height: 12px;"></i> ${statusInfo.label}
          </span>
        </div>
        ${partialBar}
      </div>

      <div style="background: #111120; border: 1px solid #1E1E30; border-radius: 12px; padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start;">
        <div style="flex-shrink: 0; width: 32px; height: 32px; background: rgba(255,255,255,0.06); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
          <i data-lucide="shield-check" style="width: 16px; height: 16px; color: #9CA3AF;"></i>
        </div>
        <div style="flex: 1;">
          <p style="color: white; font-size: 11px; font-weight: 700; margin: 0 0 3px; text-transform: uppercase; letter-spacing: 0.05em;">About Your Security Fee</p>
          <p style="color: #9CA3AF; font-size: 11px; line-height: 1.55; margin: 0;">The monthly security fee covers 24/7 estate security personnel, gate access control and perimeter monitoring for all residents.</p>
        </div>
      </div>

      <div>
        <h3 style="color: white; font-size: 13px; font-weight: 700; margin-bottom: 8px;">Security Payment</h3>
        <button id="btn-tenant-pay-item" class="ep-item-card">
          <div class="ep-item-icon-box" style="background: #EF444422;">
            <i data-lucide="shield" style="width: 20px; height: 20px; color: #EF4444;"></i>
          </div>
          <div class="ep-item-details">
            <div class="ep-item-title">Security Fee</div>
            <div class="ep-item-desc">${activeBill ? activeBill.period : "-"} Security Levy</div>
            <div class="ep-item-meta">Balance: KSh ${balance.toLocaleString()} of ${activeBill ? activeBill.amount.toLocaleString() : "0"}</div>
          </div>
          <div class="ep-item-right">
            <div class="ep-item-amount">KSh ${balance.toLocaleString()}</div>
            <span class="ep-status-badge" style="background: ${statusInfo.bg}; color: ${statusInfo.color}; font-size: 8px; padding: 1px 4px;">${statusInfo.label}</span>
          </div>
        </button>
      </div>

      <div>
        <h3 style="color: white; font-size: 13px; font-weight: 700; margin-bottom: 8px;">Quick Actions</h3>
        <div class="ep-actions-grid">
          <button id="btn-action-pay" class="ep-action-btn">
            <i data-lucide="credit-card" style="width: 18px; height: 18px; color: #1976D2;"></i>
            <span>Pay Now</span>
          </button>
          <button id="btn-action-history" class="ep-action-btn">
            <i data-lucide="receipt" style="width: 18px; height: 18px; color: #1976D2;"></i>
            <span>View Receipts</span>
          </button>
        </div>
        <button id="btn-whatsapp-bot" class="ep-action-btn" style="flex-direction:row;justify-content:center;gap:8px;width:100%;margin-top:10px;border-color:rgba(37,211,102,0.25);background:rgba(37,211,102,0.06);">
          <i data-lucide="message-circle" style="width:18px;height:18px;color:#25D366;"></i>
          <span style="color:#25D366;">Chat with EstatePay on WhatsApp</span>
        </button>
      </div>
    `;
  } else if (tenantActiveTab === "announcements") {
    const html = announcements.length
      ? announcements.map((a) => `
          <div style="background: ${a.pinned ? "rgba(25,118,210,0.12)" : "#111120"}; border: 1px solid ${a.pinned ? "#1976D2" : "#1E1E30"}; border-radius: 10px; padding: 10px 12px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <i data-lucide="${a.pinned ? "pin" : "megaphone"}" style="width:10px;height:10px;color:${a.pinned ? "#1976D2" : "#9CA3AF"};flex-shrink:0;"></i>
              <span style="color: ${a.pinned ? "#60A5FA" : "white"}; font-weight: 700; font-size: 11px;">${a.title}</span>
            </div>
            <p style="color: #9CA3AF; font-size: 10px; line-height: 1.5; margin:0 0 4px;">${a.body}</p>
            <span style="color:#4B5563;font-size:9px;">${a.createdAt?.toDate ? a.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""}</span>
          </div>
        `).join("")
      : `<p style="color: #4B5563; font-size: 11px; font-style: italic; text-align: center; padding: 8px 0;">No announcements yet.</p>`;
    contentHtml = `<h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom:4px;">Estate Forum</h2><div style="display:flex;flex-direction:column;gap:8px;">${html}</div>`;
  } else if (tenantActiveTab === "payments") {
    contentHtml = `
      <h2 style="color: white; font-size: 15px; font-weight: 700; margin-bottom: 4px;">Security Payment</h2>
      <div class="ep-detail-card" style="display:flex;flex-direction:column;gap:12px;padding:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="ep-item-icon-box" style="background:#EF444422;width:36px;height:36px;">
            <i data-lucide="shield" style="width:18px;height:18px;color:#EF4444;"></i>
          </div>
          <div style="flex:1;">
            <p style="color:white;font-weight:600;font-size:13px;margin:0;">Security Fee</p>
            <p style="color:#6B7280;font-size:10px;margin:1px 0 0;">${activeBill ? activeBill.period : "-"} Security Levy</p>
          </div>
          <span class="ep-status-badge" style="background:${statusInfo.bg};color:${statusInfo.color};font-size:9px;padding:1px 5px;">${statusInfo.label}</span>
        </div>
        <div style="background:#1A1A2A;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#9CA3AF;font-size:11px;">Total Bill</span>
            <span style="color:#E5E7EB;font-size:12px;">KSh ${activeBill ? activeBill.amount.toLocaleString() : "0"}</span>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#9CA3AF;font-size:11px;">Paid So Far</span>
            <span style="color:#10B981;font-size:12px;font-weight:600;">KSh ${amountPaid.toLocaleString()}</span>
          </div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid #2A2A3A;padding-top:6px;margin-top:2px;">
            <span style="color:#9CA3AF;font-size:11px;">Balance Due</span>
            <span style="color:white;font-weight:800;font-size:15px;">KSh ${balance.toLocaleString()}</span>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#9CA3AF;font-size:11px;">House</span>
            <span style="color:#E5E7EB;font-size:11px;">House ${houseLabel}</span>
          </div>
        </div>
        ${!activeBill
          ? `<div style="background:#1A1A2A;border:1px solid #2A2A3A;color:#9CA3AF;border-radius:8px;padding:10px;text-align:center;font-size:11px;">
               No bill has been generated for your house yet. Your estate manager runs billing monthly — check back soon, or ask them to run it early.
             </div>`
          : isDue
            ? `<button id="btn-payments-pay-now" class="ep-btn-primary" style="padding:10px;">Pay Balance — KSh ${balance.toLocaleString()}</button>`
            : `<div style="background:#10B98122;border:1px solid #10B981;color:#10B981;border-radius:8px;padding:8px;display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:12px;margin-bottom:8px;">
                 <i data-lucide="check-circle-2" style="width:14px;height:14px;"></i><span>Payment Completed</span>
               </div>
               <button id="btn-payments-pay-now" class="ep-btn-primary" style="padding:10px;background:#1976D2;">Pay in Advance for Next Month</button>`}
      </div>
    `;
  } else if (tenantActiveTab === "history") {
    const rows = paymentHistory.length
      ? paymentHistory.map((t) => `
          <div class="ep-history-item" style="padding:10px 12px;">
            <div class="ep-item-icon-box" style="background:#10B98122;width:32px;height:32px;">
              <i data-lucide="shield" style="width:16px;height:16px;color:#10B981;"></i>
            </div>
            <div style="flex:1;">
              <p style="color:white;font-weight:600;font-size:11px;margin:0;">Security Fee</p>
              <p style="color:#6B7280;font-size:9px;margin:1px 0 0;">${t.completedAt?.toDate ? t.completedAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""} · ${t.mpesaReceiptNumber || t.status}</p>
            </div>
            <div style="text-align:right;">
              <p style="color:#10B981;font-weight:700;font-size:12px;margin:0;">KSh ${(t.amount || 0).toLocaleString()}</p>
              <span style="color:#10B981;font-size:8px;font-weight:600;">${t.status === "success" ? "Paid" : t.status}</span>
            </div>
          </div>
        `).join("")
      : `<p style="color:#6B7280;font-size:11px;text-align:center;padding:16px 0;">No payments yet.</p>`;
    contentHtml = `<h2 style="color:white;font-size:15px;font-weight:700;margin-bottom:4px;">Payment History</h2><div style="display:flex;flex-direction:column;gap:6px;">${rows}</div>`;
  } else if (tenantActiveTab === "profile") {
    const membersHtml = householdMembers.length
      ? householdMembers.map((m) => `
          <div style="display:flex;align-items:center;gap:8px;background:#1A1A2A;border-radius:6px;padding:6px 8px;">
            <div style="position:relative;width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#1565C0,#1976D2);display:flex;align-items:center;justify-content:center;color:white;">
              <i data-lucide="user" style="width:12px;height:12px;"></i>
              <span style="position:absolute;bottom:0;right:0;width:6px;height:6px;border-radius:50%;background:#10B981;border:1px solid #1A1A2A;"></span>
            </div>
            <div style="flex:1;">
              <p style="color:white;font-size:10px;font-weight:600;margin:0;">${m.fullName || "Resident"}</p>
              <p style="color:#6B7280;font-size:8px;margin:0;">${unitDoc?.householdOwnerPhone === m.id ? "Owner" : "Member"} · ${m.id}</p>
            </div>
          </div>`).join("")
      : `<div style="background:#1A1A2A;border-radius:6px;padding:10px;color:#6B7280;font-size:10px;text-align:center;">No other household members yet.</div>`;

    contentHtml = `
      <div style="display:flex;flex-direction:column;align-items:center;padding:8px 0 12px;">
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#1565C0,#1976D2);display:flex;align-items:center;justify-content:center;color:white;margin-bottom:8px;">
          <i data-lucide="user" style="width:26px;height:26px;"></i>
        </div>
        <h3 style="color:white;font-size:14px;font-weight:700;margin:0;">${tenantDoc?.fullName || "Tenant"}</h3>
        <p style="color:#9CA3AF;font-size:10px;margin:2px 0 0;">House ${houseLabel}</p>
      </div>

      <div class="ep-detail-card" style="display:flex;flex-direction:column;gap:6px;padding:10px;">
        <div class="ep-detail-row" style="padding:4px 0;"><span class="ep-detail-label">House Number</span><span class="ep-detail-val">${houseLabel}</span></div>
        <div class="ep-detail-row" style="padding:4px 0;"><span class="ep-detail-label">Phone</span><span class="ep-detail-val">${currentUser?.phoneNumber || "-"}</span></div>
      </div>

      ${isOwner ? `
        <div class="ep-detail-card" style="padding:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="color:#9CA3AF;font-size:11px;font-weight:600;">Household Invite Link</span>
            <span style="background:rgba(16,185,129,0.15);color:#34D399;font-size:8px;font-weight:600;padding:1px 4px;border-radius:12px;">Owner</span>
          </div>
          <button id="btn-profile-invite" class="ep-btn-primary" style="padding:9px;font-size:11px;background:#10B981;box-shadow:0 8px 20px rgba(16,185,129,0.18);">
            <i data-lucide="send" style="width:13px;height:13px;"></i> Copy Household Link
          </button>
        </div>` : ""}

      <div class="ep-detail-card" style="padding:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="color:#9CA3AF;font-size:11px;font-weight:600;">Household Members</span>
          <span style="background:rgba(25,118,210,0.15);color:#60A5FA;font-size:8px;font-weight:600;padding:1px 4px;border-radius:12px;">House ${houseLabel}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">${membersHtml}</div>
      </div>

      <button id="btn-signout" class="ep-btn-primary" style="background:rgba(239,68,68,0.15);border:1px solid #EF4444;color:#EF4444;box-shadow:none;padding:10px;font-size:12px;">
        <i data-lucide="log-out" style="width:14px;height:14px;"></i> Sign Out
      </button>
    `;
  }

  let paymentModalHtml = "";
  if (payingBillId && activeBill) {
    const suggestedAmt = balance > 0 ? balance : (unitDoc?.monthlyRate || activeBill.amount || 0);
    const defaultAmt = paymentAmountInput || suggestedAmt.toString();
    paymentModalHtml = `
      <div class="ep-modal-overlay">
        <div class="ep-modal-content" id="payment-modal-container">
          <div class="ep-modal-header" style="margin-bottom:12px;">
            <span class="ep-modal-title">Make Payment</span>
            <button class="ep-modal-close" id="btn-close-payment-modal"><i data-lucide="x" style="width:18px;height:18px;"></i></button>
          </div>
          <div style="background:#1A1A2A;border-radius:10px;padding:10px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <div class="ep-item-icon-box" style="background:#EF444422;width:32px;height:32px;">
                <i data-lucide="shield" style="width:16px;height:16px;color:#EF4444;"></i>
              </div>
              <div style="flex:1;">
                <p style="color:white;font-weight:600;font-size:12px;margin:0;">Security Fee — ${activeBill.period}</p>
                <p style="color:#6B7280;font-size:10px;margin:1px 0 0;">House ${houseLabel}</p>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #2A2A3A;padding-top:8px;">
              <span style="color:#9CA3AF;font-size:11px;">Current Balance</span>
              <span style="color:${balanceView.color};font-weight:800;font-size:16px;">${balanceView.label}</span>
            </div>
          </div>
          <div style="margin-bottom:14px;">
            <label style="color:#9CA3AF;font-size:11px;display:block;margin-bottom:6px;">Enter Amount to Pay (KSh)</label>
            <input type="number" id="input-payment-amount" class="ep-input" style="font-weight:700;color:white;" placeholder="${balance}" value="${defaultAmt}" min="1">
            <p style="color:#4B5563;font-size:10px;margin-top:4px;">You can pay any amount, including partial payments.</p>
          </div>
          <button id="btn-confirm-payment" class="ep-btn-primary" style="padding:12px;font-size:13px;">
            <i data-lucide="credit-card" style="width:14px;height:14px;"></i> Confirm & Pay via M-Pesa
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="ep-screen">
      <div class="ep-dashboard">
        <div class="ep-dashboard-header">
          <div class="ep-header-profile">
            <div class="ep-header-avatar"><i data-lucide="wallet" style="width:18px;height:18px;"></i></div>
            <div class="ep-header-info">
              <p class="ep-welcome">Welcome back</p>
              <p class="ep-user-title">House ${houseLabel}</p>
            </div>
          </div>
        </div>
        <div class="ep-dashboard-content" style="padding-bottom:70px;">
          ${toastMessage ? `<div class="ep-toast"><i data-lucide="check-circle-2" style="width:16px;height:16px;color:#10B981;"></i><span>${toastMessage}</span></div>` : ""}
          ${contentHtml}
        </div>
        <div class="ep-bottom-nav">
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "home" ? "active" : ""}" data-tab="home"><i data-lucide="home"></i><span>Home</span></button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "announcements" ? "active" : ""}" data-tab="announcements"><i data-lucide="megaphone"></i><span>Forum</span></button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "payments" ? "active" : ""}" data-tab="payments"><i data-lucide="credit-card"></i><span>Pay</span></button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "history" ? "active" : ""}" data-tab="history"><i data-lucide="receipt"></i><span>History</span></button>
          <button class="ep-bottom-nav-btn ${tenantActiveTab === "profile" ? "active" : ""}" data-tab="profile"><i data-lucide="user"></i><span>Profile</span></button>
        </div>
        ${paymentModalHtml}
      </div>
    </div>
  `;
}

function renderManagerDashboard() {
  const myProfile = managerTenants.find((t) => t.id === currentUser?.phoneNumber);
  const totalUnits = managerUnits.length;
  const totalExpected = managerBills.reduce((sum, b) => sum + (b.amount || 0), 0);
  const totalCollected = managerBills.reduce((sum, b) => sum + (b.amountPaid || 0), 0);
  const settledCount = managerBills.filter((b) => (b.balance || 0) <= 0).length;
  const pendingCount = managerBills.filter((b) => (b.balance || 0) > 0).length;
  const collectionRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;

  const byPeriod = {};
  managerBills.forEach((b) => {
    if (!b.period) return;
    byPeriod[b.period] = (byPeriod[b.period] || 0) + (b.amountPaid || 0);
  });
  const chartData = Object.keys(byPeriod).sort().slice(-6).map((period) => ({ month: period.slice(5), collected: byPeriod[period] }));

  const unitOwnerName = {};
  managerTenants.forEach((t) => { if (t.unitId) unitOwnerName[t.unitId] = t.fullName; });

  let contentHtml = "";

  if (managerActiveTab === "overview") {
    const unpaidUnits = managerUnits.filter((u) => {
      const bill = managerBills.find((b) => b.unitId === u.id);
      return bill && bill.balance > 0;
    });

    contentHtml = `
      <div class="ep-manager-stats-2col">
        <div class="ep-stat-card-gradient">
          <span class="ep-stat-label-gradient">Collected</span>
          <div class="ep-stat-val-lg">KSh ${totalCollected.toLocaleString()}</div>
          <div class="ep-stat-meta-green"><i data-lucide="trending-up" style="width:12px;height:12px;"></i><span>${collectionRate}% rate</span></div>
        </div>
        <div class="ep-stat-card">
          <span class="ep-stat-label">Expected</span>
          <div class="ep-stat-val-lg">KSh ${totalExpected.toLocaleString()}</div>
          <div class="ep-stat-meta-red">KSh ${(totalExpected - totalCollected).toLocaleString()} outstanding</div>
        </div>
      </div>

      <div class="ep-manager-stats-3col">
        <div class="ep-stat-card" style="border-color:rgba(25,118,210,0.15);">
          <i data-lucide="home" style="width:14px;height:14px;color:#1976D2;"></i>
          <div class="ep-stat-val" style="margin-top:2px;font-size:14px;">${totalUnits}</div>
          <span class="ep-stat-label">Total Units</span>
        </div>
        <div class="ep-stat-card" style="border-color:rgba(16,185,129,0.15);">
          <i data-lucide="check-circle-2" style="width:14px;height:14px;color:#10B981;"></i>
          <div class="ep-stat-val" style="margin-top:2px;font-size:14px;">${settledCount}</div>
          <span class="ep-stat-label">Settled</span>
        </div>
        <div class="ep-stat-card" style="border-color:rgba(239,68,68,0.15);">
          <i data-lucide="alert-circle" style="width:14px;height:14px;color:#EF4444;"></i>
          <div class="ep-stat-val" style="margin-top:2px;font-size:14px;">${pendingCount}</div>
          <span class="ep-stat-label">Unpaid</span>
        </div>
      </div>

      <div class="ep-detail-card" style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;">
          <span style="color:white;font-weight:600;">Security Fee Collection</span>
          <span style="color:#1976D2;font-weight:700;">${collectionRate}%</span>
        </div>
        <div style="height:5px;background:#1A1A2A;border-radius:999px;overflow:hidden;">
          <div style="width:${collectionRate}%;height:100%;background:linear-gradient(90deg,#1565C0,#1976D2);border-radius:999px;"></div>
        </div>
      </div>

      <div class="ep-detail-card" style="padding:10px 12px;">
        <p style="color:white;font-size:11px;font-weight:600;margin-bottom:8px;">Monthly Security Collections</p>
        ${renderManagerBarChart(chartData)}
      </div>

      <div>
        <h3 style="color:white;font-size:13px;font-weight:700;margin-bottom:8px;">Run Billing</h3>
        <button id="btn-run-billing" class="ep-action-btn" style="width:100%;flex-direction:row;justify-content:center;gap:8px;">
          <i data-lucide="zap" style="width:16px;height:16px;color:#1976D2;"></i><span>Run Billing Engine Now</span>
        </button>
      </div>

      <div>
        <h3 style="color:white;font-size:13px;font-weight:700;margin-bottom:8px;">Unpaid Houses</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${unpaidUnits.length ? unpaidUnits.map((u) => `
            <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:8px 10px;display:flex;align-items:center;gap:8px;">
              <i data-lucide="alert-circle" style="width:14px;height:14px;color:#EF4444;flex-shrink:0;"></i>
              <div style="flex:1;">
                <p style="color:white;font-size:11px;font-weight:600;margin:0;">House ${u.houseNumber}</p>
                <p style="color:#9CA3AF;font-size:9px;margin:1px 0 0;">${unitOwnerName[u.id] || "Occupied"}</p>
              </div>
            </div>`).join("") : '<div style="color:#6B7280;font-size:11px;font-style:italic;text-align:center;padding:10px 0;">No unpaid houses.</div>'}
        </div>
      </div>
    `;
  } else if (managerActiveTab === "tenants") {
    const filtered = managerTenants.filter((t) => {
      const unit = managerUnits.find((u) => u.id === t.unitId);
      const matchSearch = (t.fullName || "").toLowerCase().includes(managerSearch.toLowerCase()) ||
        (unit?.houseNumber || "").toLowerCase().includes(managerSearch.toLowerCase());
      const bill = managerBills.find((b) => b.unitId === t.unitId);
      const status = bill && bill.balance > 0 ? "pending" : "paid";
      const matchFilter = managerFilterStatus === "all" || managerFilterStatus === status;
      return matchSearch && matchFilter;
    });

    const rows = filtered.map((t) => {
      const unit = managerUnits.find((u) => u.id === t.unitId);
      const bill = managerBills.find((b) => b.unitId === t.unitId);
      const balance = bill ? bill.balance : 0;
      const bv = getBalanceDisplay(balance);
      return `
        <div class="ep-item-card" style="margin-bottom:6px;padding:10px;">
          <div style="flex:1;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="color:white;font-size:12px;font-weight:600;">${t.fullName}</span>
              <span style="color:${bv.color};font-size:11px;font-weight:800;white-space:nowrap;">${bv.label}</span>
            </div>
            <div style="background:${bv.color}20;border-radius:4px;padding:4px 8px;display:flex;align-items:center;gap:4px;font-size:9px;color:${bv.color};font-weight:600;">
              <i data-lucide="home" style="width:10px;height:10px;"></i><span>House ${unit?.houseNumber || "-"}</span>
              <span style="margin-left:auto;">${balance > 0 ? "Unpaid" : (balance < 0 ? "Overpaid" : "Zero balance")}</span>
            </div>
          </div>
        </div>`;
    }).join("");

    contentHtml = `
      <h2 style="color:white;font-size:15px;font-weight:700;margin-bottom:4px;">Registered Houses</h2>
      <div class="ep-search-container">
        <i data-lucide="search" class="ep-search-icon" style="width:12px;height:12px;"></i>
        <input type="text" id="input-manager-search" class="ep-search-input" placeholder="Search house or name..." value="${managerSearch}">
      </div>
      <div class="ep-horizontal-tags">
        <button class="ep-tag-btn ${managerFilterStatus === "all" ? "active" : ""}" data-filter="all">All</button>
        <button class="ep-tag-btn ${managerFilterStatus === "pending" ? "active" : ""}" data-filter="pending">Unpaid</button>
        <button class="ep-tag-btn ${managerFilterStatus === "paid" ? "active" : ""}" data-filter="paid">Settled</button>
      </div>
      <div style="display:flex;flex-direction:column;">
        ${rows || '<div style="color:#6B7280;font-size:11px;text-align:center;padding:16px 0;">No matching houses found.</div>'}
      </div>
    `;
  } else if (managerActiveTab === "notices") {
    const annHistory = announcements.length
      ? announcements.map((a) => `
          <div class="ep-detail-card" style="padding:10px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
              <span style="color:white;font-weight:700;font-size:11px;flex:1;">${a.title}</span>
              <span style="color:#4B5563;font-size:9px;margin-left:8px;">${a.createdAt?.toDate ? a.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span>
            </div>
            <p style="color:#9CA3AF;font-size:10px;line-height:1.4;margin:0;">${a.body}</p>
          </div>`).join("")
      : `<p style="color:#4B5563;font-size:11px;font-style:italic;text-align:center;padding:12px 0;">No announcements posted yet.</p>`;

    contentHtml = `
      <h2 style="color:white;font-size:15px;font-weight:700;margin-bottom:4px;">Estate Announcements</h2>
      <div class="ep-detail-card" style="display:flex;flex-direction:column;gap:10px;padding:10px;">
        <h3 style="color:white;font-size:12px;font-weight:600;margin:0;">Post New Announcement</h3>
        <div>
          <label style="color:#9CA3AF;font-size:10px;display:block;margin-bottom:4px;">Title</label>
          <input type="text" id="input-ann-title" class="ep-input" placeholder="e.g. Water Shutdown Notice">
        </div>
        <div>
          <label style="color:#9CA3AF;font-size:10px;display:block;margin-bottom:4px;">Message</label>
          <textarea id="textarea-ann-body" class="ep-textarea" placeholder="Type your announcement here..."></textarea>
        </div>
        <button id="btn-post-announcement" class="ep-btn-primary" style="padding:10px;font-size:12px;">
          <i data-lucide="megaphone" style="width:12px;height:12px;"></i> Post Announcement
        </button>
      </div>
      <div>
        <h3 style="color:white;font-size:11px;font-weight:600;margin-bottom:6px;">Recently Posted</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">${annHistory}</div>
      </div>
    `;
  } else if (managerActiveTab === "reports") {
    contentHtml = `
      <h2 style="color:white;font-size:15px;font-weight:700;">Reports</h2>
      <p style="color:#9CA3AF;font-size:11px;">Full reporting (arrears aging, exports) isn't wired to real aggregation queries yet — build this out with Firestore aggregate queries or BigQuery export once you have real production traffic to report on.</p>
    `;
  }

  return `
    <div class="ep-screen">
      <div class="ep-dashboard">
        <div class="ep-dashboard-header">
          <div class="ep-header-profile">
            <div class="ep-header-avatar"><i data-lucide="shield-check" style="width:18px;height:18px;"></i></div>
            <div class="ep-header-info">
              <p class="ep-welcome">Estate Manager</p>
              <p class="ep-user-title">${myProfile?.fullName || "Manager"}</p>
            </div>
          </div>
          <button id="btn-manager-signout" class="ep-header-btn danger" title="Sign out">
            <i data-lucide="log-out" style="width:16px;height:16px;"></i>
          </button>
        </div>
        <div class="ep-dashboard-content" style="padding-bottom:70px;">
          ${toastMessage ? `<div class="ep-toast"><i data-lucide="check-circle-2" style="width:16px;height:16px;color:#10B981;"></i><span>${toastMessage}</span></div>` : ""}
          ${contentHtml}
        </div>
        <div class="ep-bottom-nav" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
          <button class="ep-bottom-nav-btn ${managerActiveTab === "overview" ? "active" : ""}" data-mtab="overview"><i data-lucide="layout-dashboard"></i><span>Overview</span></button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "tenants" ? "active" : ""}" data-mtab="tenants"><i data-lucide="users"></i><span>Tenants</span></button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "notices" ? "active" : ""}" data-mtab="notices"><i data-lucide="megaphone"></i><span>Notices</span></button>
          <button class="ep-bottom-nav-btn ${managerActiveTab === "reports" ? "active" : ""}" data-mtab="reports"><i data-lucide="bar-chart-2"></i><span>Reports</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderManagerBarChart(data) {
  if (!data.length) return `<p style="color:#4B5563;font-size:10px;text-align:center;">No billing history yet.</p>`;
  const maxVal = Math.max(...data.map((d) => d.collected), 1);
  const chartH = 80, barW = 20, gap = 12;
  const totalW = data.length * (barW + gap) - gap;
  let gHtml = "";
  data.forEach((d, i) => {
    const barH = Math.round((d.collected / maxVal) * chartH) || 4;
    const x = i * (barW + gap);
    const y = chartH - barH;
    const isLast = i === data.length - 1;
    gHtml += `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${isLast ? "#1976D2" : "#1E2D4A"}" rx="3" />
        <text x="${x + barW / 2}" y="${chartH + 12}" text-anchor="middle" fill="#6B7280" style="font-size: 8px;">${d.month}</text>
      </g>`;
  });
  return `<div style="overflow-x:auto;width:100%;display:flex;justify-content:center;padding-top:4px;">
    <svg width="${totalW}" height="${chartH + 16}" style="display:block;">${gHtml}</svg>
  </div>`;
}

function renderApp() {
  const root = document.getElementById("mobile-app-root");
  if (!root) return;

  const screens = {
    splash: renderSplash,
    auth: renderAuth,
    otp: renderOtp,
    "set-password": renderSetPassword,
    "house-entry": renderHouseEntry,
    "tenant-dashboard": renderTenantDashboard,
    "manager-dashboard": renderManagerDashboard,
  };

  root.innerHTML = (screens[currentScreen] || renderSplash)();
  if (window.lucide) window.lucide.createIcons();
}

// ==========================================================================
// 7. Event delegation
// ==========================================================================
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button, .ep-bottom-nav-btn");
  if (!btn) return;
  const id = btn.id;
  const tab = btn.getAttribute("data-tab");
  const mtab = btn.getAttribute("data-mtab");

  if (tab) { tenantActiveTab = tab; renderApp(); return; }
  if (mtab) { managerActiveTab = mtab; renderApp(); return; }

  if (id === "btn-splash-get-started") {
    authMode = "login";
    authPassword = "";
    authConfirmPassword = "";
    currentScreen = "auth";
    renderApp();
    return;
  }

  // Tab switcher on the auth screen
  if (id === "btn-tab-login") { authMode = "login"; renderApp(); return; }
  if (id === "btn-tab-signup") { authMode = "signup"; renderApp(); return; }

  if (id === "btn-auth-back" || id === "btn-house-back") { currentScreen = "splash"; renderApp(); return; }
  if (id === "btn-otp-back") { currentScreen = "auth"; renderApp(); return; }

  // Show/hide password toggle
  if (id === "btn-toggle-pw") {
    const pwInput = document.getElementById("input-auth-password");
    if (pwInput) pwInput.type = pwInput.type === "password" ? "text" : "password";
    return;
  }

  // Login with phone + password
  if (id === "btn-auth-login") {
    await handleLogin();
    return;
  }

  if (id === "btn-auth-send-otp") {
    if (!authPhone || !authFullName) { showToast("Please enter your name and phone number."); return; }
    try {
      await sendOtp(authPhone);
      currentScreen = "otp";
      renderApp();
    } catch (err) {
      showToast(err.message || "Could not send verification code.");
    }
    return;
  }

  if (id === "btn-otp-confirm") {
    try {
      await confirmOtp(otpCode);
      // onAuthStateChanged fires and moves to set-password for new users.
    } catch (err) {
      showToast("Incorrect code. Please try again.");
    }
    return;
  }

  // Set password after OTP verification
  if (id === "btn-set-password") {
    await handleSetPassword();
    return;
  }

  if (id === "btn-skip-password") {
    // User skips setting a password — go straight to house entry.
    currentScreen = "house-entry";
    householdEntryStep = "search";
    await loadEstatesOnce();
    renderApp();
    return;
  }

  if (id === "btn-house-register") {
    if (!registerEstateId || !houseNumberInput) { showToast("Please select an estate and enter a house number."); return; }
    await handleRegisterHousehold();
    return;
  }
  if (id === "btn-house-goto-search") { householdEntryStep = "search"; renderApp(); return; }
  if (id === "btn-house-join-invite") {
    if (!householdInviteInput) { showToast("Please paste your invite link."); return; }
    await handleJoinWithInvite();
    return;
  }

  if (id === "btn-action-pay") { tenantActiveTab = "payments"; renderApp(); return; }
  if (id === "btn-action-history") { tenantActiveTab = "history"; renderApp(); return; }
  if (id === "btn-tenant-pay-item" || id === "btn-payments-pay-now") {
    if (!activeBill) {
      showToast("No bill exists yet for your house — ask your estate manager to run billing first.");
      return;
    }
    payingBillId = activeBill.id;
    paymentAmountInput = "";
    renderApp();
    return;
  }
  if (id === "btn-close-payment-modal") { payingBillId = null; paymentAmountInput = ""; renderApp(); return; }
  if (id === "btn-confirm-payment") {
    const amountInput = document.getElementById("input-payment-amount");
    const amount = amountInput?.value ? Number(amountInput.value) : null;
    await handlePayNow(amount);
    return;
  }
  if (id === "btn-whatsapp-bot") {
    const houseLabel = unitDoc?.houseNumber || "";
    const prefill = houseLabel
      ? `Hi, this is ${authFullName || tenantDoc?.fullName || ""} from House ${houseLabel}.`
      : "Hi, I'd like help with my EstatePay account.";
    const url = `https://wa.me/${WHATSAPP_BOT_NUMBER}?text=${encodeURIComponent(prefill)}`;
    window.open(url, "_blank");
    return;
  }
  if (id === "btn-profile-invite") { await handleGenerateInvite(); return; }
  if (id === "btn-signout" || id === "btn-manager-signout") {
    localStorage.removeItem("estatepay_cached_role");
    await signOut(auth);
    clearSubscriptions();
    return;
  }

  if (id === "btn-run-billing") { await handleRunBilling(); return; }
  if (id === "btn-post-announcement") {
    const title = document.getElementById("input-ann-title")?.value;
    const body = document.getElementById("textarea-ann-body")?.value;
    if (!title || !body) { showToast("Please fill in both the title and message."); return; }
    await handlePostAnnouncement(title, body);
    return;
  }

  const filterBtn = e.target.closest(".ep-tag-btn");
  if (filterBtn && filterBtn.hasAttribute("data-filter")) {
    managerFilterStatus = filterBtn.getAttribute("data-filter");
    renderApp();
    return;
  }
});

document.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "input-auth-name") authFullName = e.target.value;
  if (id === "input-auth-phone") authPhone = e.target.value;
  if (id === "input-auth-password") authPassword = e.target.value;
  if (id === "input-set-password") authPassword = e.target.value;
  if (id === "input-confirm-password") authConfirmPassword = e.target.value;
  if (id === "input-otp-code") otpCode = e.target.value;
  if (id === "input-reg-estate") registerEstateId = e.target.value;
  if (id === "input-house-number") houseNumberInput = e.target.value;
  if (id === "input-household-invite") householdInviteInput = e.target.value;
  if (id === "input-payment-amount") paymentAmountInput = e.target.value;
  if (id === "input-manager-search") {
    managerSearch = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderApp();
    const newInput = document.getElementById("input-manager-search");
    if (newInput) {
      newInput.focus();
      newInput.setSelectionRange(cursorPos, cursorPos);
    }
  }
});

// ==========================================================================
// 8. Boot
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  const incomingInviteToken = new URL(window.location.href).searchParams.get("householdInvite");
  if (incomingInviteToken) householdInviteInput = incomingInviteToken;
  renderApp();
});
/**
 * ONE-TIME BOOTSTRAP SCRIPT
 * Creates your first estate, its house units, and your first estate manager
 * account. Run this locally (NOT as a Cloud Function) before you onboard
 * any real residents.
 *
 * Setup:
 *   1. In Firebase Console > Project Settings > Service Accounts,
 *      click "Generate new private key" and save it as:
 *      scripts/serviceAccountKey.json   (this file is gitignored — never commit it)
 *   2. npm install firebase-admin   (from inside /scripts, or reuse the functions/node_modules)
 *   3. Edit the ESTATE / UNITS / MANAGER constants below.
 *   4. node bootstrap.js
 *
 * What it does:
 *   - Creates estates/{estateId}
 *   - Creates estates/{estateId}/units/{unitId} for each unit you list
 *   - Creates a Firebase Auth user for your manager's phone number (if one
 *     doesn't already exist)
 *   - Creates tenants/{managerPhone} with role: "admin"
 *   - Sets the matching custom claims directly (so you don't have to wait
 *     for the onTenantWrite trigger's first sync)
 */

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

// ---------------------------------------------------------------------
// EDIT THESE before running
// ---------------------------------------------------------------------
const ESTATE_ID = "estate-1";
const ESTATE = {
  name: "Komarock",
  location: "Komarock, Nairobi",
  adminPhoneNumbers: ["+254795582818"],
  billingDay: 5,
};

const UNITS = [
  { id: "unit-1-1", houseNumber: "1", block: "A", monthlyRate: 1000 },
  { id: "unit-1-2", houseNumber: "2", block: "A", monthlyRate: 1000 },
  { id: "unit-1-3", houseNumber: "3", block: "A", monthlyRate: 1000 },
];

const MANAGER = {
  phone: "+254795582818", // E.164 format — using the test number already in Firebase Console
  fullName: "Jayden Christopher",
};
// ---------------------------------------------------------------------

async function run() {
  console.log(`Creating estate ${ESTATE_ID}...`);
  await db.collection("estates").doc(ESTATE_ID).set({
    ...ESTATE,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  for (const unit of UNITS) {
    console.log(`Creating unit ${unit.houseNumber}...`);
    await db.collection("estates").doc(ESTATE_ID).collection("units").doc(unit.id).set({
      houseNumber: unit.houseNumber,
      block: unit.block,
      monthlyRate: unit.monthlyRate,
      occupied: false,
      currentTenantPhone: null,
      householdOwnerPhone: null,
      inviteToken: null,
    });
  }

  console.log(`Setting up manager account for ${MANAGER.phone}...`);
  let userRecord;
  try {
    userRecord = await auth.getUserByPhoneNumber(MANAGER.phone);
    console.log("Auth user already exists, reusing it.");
  } catch {
    userRecord = await auth.createUser({ phoneNumber: MANAGER.phone });
    console.log("Created new Auth user.");
  }

  await db.collection("tenants").doc(MANAGER.phone).set({
    fullName: MANAGER.fullName,
    estateId: ESTATE_ID,
    unitId: null,
    role: "admin",
    verified: true,
    whatsappSessionState: { state: "MAIN_MENU", data: {} },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await auth.setCustomUserClaims(userRecord.uid, {
    role: "admin",
    estateId: ESTATE_ID,
    unitId: null,
  });

  console.log("\n✅ Bootstrap complete.");
  console.log(`Manager can now log in with phone ${MANAGER.phone} — they'll land on the Manager Dashboard.`);
  console.log(`${UNITS.length} house unit(s) are ready for residents to register against.`);
}

run().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
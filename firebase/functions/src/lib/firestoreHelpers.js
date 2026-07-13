const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = () => getFirestore();

/** Normalizes phone input to E.164 (assumes Kenyan numbers when no country code given). */
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[\s-]/g, "");
  if (p.startsWith("0")) p = "+254" + p.slice(1);
  else if (p.startsWith("254")) p = "+" + p;
  else if (!p.startsWith("+")) p = "+254" + p;
  return p;
}

/** Generates a URL-safe random token for household invites. */
function generateInviteToken() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let token = "";
  for (let i = 0; i < 24; i++) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

/** Throws a firebase-functions HttpsError-friendly plain error with a code. */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function getTenant(phone) {
  const snap = await db().collection("tenants").doc(phone).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getUnit(estateId, unitId) {
  const snap = await db().collection("estates").doc(estateId)
    .collection("units").doc(unitId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function findUnitByInviteToken(token) {
  const estatesSnap = await db().collection("estates").get();
  for (const estateDoc of estatesSnap.docs) {
    const unitsSnap = await estateDoc.ref.collection("units")
      .where("inviteToken", "==", token).limit(1).get();
    if (!unitsSnap.empty) {
      const unitDoc = unitsSnap.docs[0];
      return { estateId: estateDoc.id, unitId: unitDoc.id, unit: unitDoc.data() };
    }
  }
  return null;
}

async function findUnitByHouseNumber(estateId, houseNumber) {
  const unitsSnap = await db().collection("estates").doc(estateId)
    .collection("units").where("houseNumber", "==", houseNumber).limit(1).get();
  if (unitsSnap.empty) return null;
  const unitDoc = unitsSnap.docs[0];
  return { unitId: unitDoc.id, unit: unitDoc.data() };
}

module.exports = {
  db,
  FieldValue,
  normalizePhone,
  generateInviteToken,
  AppError,
  getTenant,
  getUnit,
  findUnitByInviteToken,
  findUnitByHouseNumber,
};

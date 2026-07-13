const { db, FieldValue, generateInviteToken, AppError, findUnitByHouseNumber, findUnitByInviteToken } = require("./firestoreHelpers");
const { getAuth } = require("firebase-admin/auth");

/**
 * Sets the Firebase Auth custom claims for a phone number immediately,
 * synchronously, as part of the same request that creates/updates their
 * tenant record — rather than relying on the onTenantWrite Firestore
 * trigger to catch up asynchronously afterward. This avoids a race
 * condition where the client could read protected data (or have its ID
 * token checked by security rules) before claims are actually set.
 *
 * onTenantWrite still exists as a defensive backstop for tenant docs that
 * get modified through other paths (e.g. manually in the Firebase Console),
 * but the primary registration/invite flows no longer depend on it.
 */
async function syncClaimsForPhone(phone, { role, estateId, unitId }) {
  const userRecord = await getAuth().getUserByPhoneNumber(phone);
  await getAuth().setCustomUserClaims(userRecord.uid, { role, estateId, unitId });
}

/**
 * Registers the FIRST resident of a house. Fails if the house is already
 * registered (has an owner) — in that case the caller must use an invite link.
 */
async function registerHousehold({ estateId, houseNumber, phone, fullName }) {
  return db().runTransaction(async (tx) => {
    const existing = await findUnitByHouseNumber(estateId, houseNumber);
    if (!existing) {
      throw new AppError("not-found", `House ${houseNumber} does not exist in this estate.`);
    }
    const { unitId, unit } = existing;
    if (unit.householdOwnerPhone) {
      throw new AppError(
        "already-exists",
        "This house is already registered. Ask the household owner for the invite link."
      );
    }

    const unitRef = db().collection("estates").doc(estateId).collection("units").doc(unitId);
    const tenantRef = db().collection("tenants").doc(phone);
    const token = generateInviteToken();

    const existingTenantSnap = await tx.get(tenantRef);
    if (existingTenantSnap.exists && ["admin", "committee"].includes(existingTenantSnap.data().role)) {
      throw new AppError(
        "permission-denied",
        "This phone number belongs to an estate manager or committee account and cannot register as a resident."
      );
    }

    tx.update(unitRef, {
      occupied: true,
      currentTenantPhone: phone,
      householdOwnerPhone: phone,
      inviteToken: token,
    });

    tx.set(tenantRef, {
      fullName,
      estateId,
      unitId,
      role: "resident",
      verified: true,
      whatsappSessionState: { state: "MAIN_MENU", data: {} },
      createdAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { estateId, unitId, inviteToken: token };
  }).then(async (result) => {
    await syncClaimsForPhone(phone, { role: "resident", estateId, unitId: result.unitId });
    return result;
  });
}

/**
 * Regenerates (or generates for the first time) the invite link/token for a
 * unit. Only the household owner may call this.
 */
async function generateHouseholdInvite({ estateId, unitId, callerPhone }) {
  const unitRef = db().collection("estates").doc(estateId).collection("units").doc(unitId);
  const unitSnap = await unitRef.get();
  if (!unitSnap.exists) throw new AppError("not-found", "Unit not found.");
  const unit = unitSnap.data();

  if (unit.householdOwnerPhone !== callerPhone) {
    throw new AppError("permission-denied", "Only the household owner can generate an invite link.");
  }

  const token = generateInviteToken();
  await unitRef.update({ inviteToken: token });
  return { inviteToken: token };
}

/**
 * Redeems an invite token: links a new tenant to the same unit as the
 * household owner. Does NOT change who the household owner is.
 */
async function redeemHouseholdInvite({ token, phone, fullName }) {
  const found = await findUnitByInviteToken(token);
  if (!found) throw new AppError("not-found", "This invite link is invalid or has expired.");
  const { estateId, unitId } = found;

  const tenantRef = db().collection("tenants").doc(phone);

  const existingTenantSnap = await tenantRef.get();
  if (existingTenantSnap.exists && ["admin", "committee"].includes(existingTenantSnap.data().role)) {
    throw new AppError(
      "permission-denied",
      "This phone number belongs to an estate manager or committee account and cannot join as a resident."
    );
  }

  await tenantRef.set({
    fullName,
    estateId,
    unitId,
    role: "resident",
    verified: true,
    whatsappSessionState: { state: "MAIN_MENU", data: {} },
    createdAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Keep currentTenantPhone pointed at whoever most recently joined/active,
  // while householdOwnerPhone (billing/invite authority) stays unchanged.
  await db().collection("estates").doc(estateId).collection("units").doc(unitId)
    .update({ currentTenantPhone: phone });

  await syncClaimsForPhone(phone, { role: "resident", estateId, unitId });

  return { estateId, unitId };
}

module.exports = { registerHousehold, generateHouseholdInvite, redeemHouseholdInvite };

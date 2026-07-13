const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getTenant, normalizePhone, AppError, getCallerPhone } = require("./lib/firestoreHelpers");
const householdLib = require("./lib/household");

function wrap(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof AppError) {
        throw new HttpsError(
          err.code === "not-found" ? "not-found" :
          err.code === "already-exists" ? "already-exists" :
          err.code === "permission-denied" ? "permission-denied" : "invalid-argument",
          err.message
        );
      }
      console.error(err);
      throw new HttpsError("internal", "Something went wrong. Please try again.");
    }
  };
}

/**
 * resolveIdentity — checks whether a phone number is already an onboarded
 * tenant. Called by the frontend right after phone auth completes, to decide
 * whether to route the user to the House Entry screen or the Dashboard.
 *
 * Supports two auth methods:
 *  1. Firebase Phone Auth  — phone_number is in the JWT claims.
 *  2. Email/Password Auth  — user signed in with pseudo-email like
 *     254712345678@estatepay.app; we extract the phone from the email.
 */
const resolveIdentity = onCall(wrap(async (request) => {
  // 1. Try helper to extract phone from phone claim or email claim
  let phone = getCallerPhone(request.auth) || normalizePhone(request.data?.phoneNumber);

  if (!phone) throw new AppError("invalid-argument", "Phone number is required.");

  const tenant = await getTenant(phone);
  if (tenant) return { exists: true, tenant: { ...tenant, phone } };
  return { exists: false };
}));


/**
 * registerHousehold — first resident of a house registers it and becomes
 * the household owner.
 */
const registerHousehold = onCall(wrap(async (request) => {
  const callerPhone = getCallerPhone(request.auth);
  if (!callerPhone) throw new AppError("invalid-argument", "You must be signed in with a verified phone number.");

  const { estateId, houseNumber, fullName } = request.data || {};
  if (!estateId || !houseNumber || !fullName) {
    throw new AppError("invalid-argument", "estateId, houseNumber, and fullName are required.");
  }

  return householdLib.registerHousehold({ estateId, houseNumber, phone: callerPhone, fullName });
}));

/**
 * generateHouseholdInvite — household owner regenerates their invite token.
 */
const generateHouseholdInvite = onCall(wrap(async (request) => {
  const callerPhone = getCallerPhone(request.auth);
  const { estateId, unitId } = request.data || {};
  if (!callerPhone || !estateId || !unitId) {
    throw new AppError("invalid-argument", "estateId and unitId are required.");
  }
  return householdLib.generateHouseholdInvite({ estateId, unitId, callerPhone });
}));

/**
 * redeemHouseholdInvite — a new resident joins an existing household using
 * an invite token (extracted from the link on the frontend before calling this).
 */
const redeemHouseholdInvite = onCall(wrap(async (request) => {
  const callerPhone = getCallerPhone(request.auth);
  const { token, fullName } = request.data || {};
  if (!callerPhone || !token || !fullName) {
    throw new AppError("invalid-argument", "token and fullName are required.");
  }
  return householdLib.redeemHouseholdInvite({ token, phone: callerPhone, fullName });
}));

/**
 * onTenantWrite — Firestore trigger that keeps the Firebase Auth custom
 * claims (role, estateId, unitId) in sync whenever a tenant document changes.
 * This is what makes the Firestore security rules' claimRole()/claimEstateId()
 * checks actually correct and current.
 */
const onTenantWrite = onDocumentWritten("tenants/{phone}", async (event) => {
  const phone = event.params.phone;
  const after = event.data?.after?.exists ? event.data.after.data() : null;

  try {
    // Try phone number first, then fall back to the pseudo-email used for
    // email/password auth (e.g. console-created admin accounts).
    let userRecord = await getAuth().getUserByPhoneNumber(phone).catch(() => null);
    if (!userRecord) {
      const email = phone.replace(/^\+/, "").replace(/\s/g, "") + "@estatepay.app";
      userRecord = await getAuth().getUserByEmail(email).catch(() => null);
    }

    if (!userRecord) {
      console.log(`onTenantWrite: no Auth user yet for ${phone}, skipping claims sync.`);
      return;
    }

    if (!after) {
      // Tenant doc deleted — clear claims.
      await getAuth().setCustomUserClaims(userRecord.uid, {});
      return;
    }

    await getAuth().setCustomUserClaims(userRecord.uid, {
      role: after.role || "resident",
      estateId: after.estateId || null,
      unitId: after.unitId || null,
    });
  } catch (err) {
    console.error("onTenantWrite claims sync failed:", err);
  }
});

module.exports = {
  resolveIdentity,
  registerHousehold,
  generateHouseholdInvite,
  redeemHouseholdInvite,
  onTenantWrite,
};

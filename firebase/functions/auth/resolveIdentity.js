/**
 * resolveIdentity() Callable Cloud Function
 * Keyed by phone number, resolves identity and manages user onboarding status
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const db = admin.firestore();

exports.resolveIdentity = functions.https.onCall(async (data, context) => {
  // Validate request payload
  const { phoneNumber } = data;
  if (!phoneNumber) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'phoneNumber'."
    );
  }

  // Normalize phone number to E.164
  const normalizedPhone = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;

  try {
    // Look up the tenant document in Firestore (O(1) direct document ID lookup)
    const tenantRef = db.collection("tenants").doc(normalizedPhone);
    const tenantSnap = await tenantRef.get();

    if (tenantSnap.exists) {
      const tenantData = tenantSnap.data();
      return {
        exists: true,
        uid: tenantData.uid,
        fullName: tenantData.fullName,
        estateId: tenantData.estateId,
        unitId: tenantData.unitId,
        role: tenantData.role,
        verified: tenantData.verified
      };
    } else {
      // Identity does not exist, trigger onboarding state
      return {
        exists: false,
        message: "Tenant profile not found. Onboarding required."
      };
    }
  } catch (error) {
    functions.logger.error("Error in resolveIdentity:", error);
    throw new functions.https.HttpsError(
      "internal",
      "An error occurred while resolving identity: " + error.message
    );
  }
});

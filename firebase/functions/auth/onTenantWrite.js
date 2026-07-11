/**
 * onTenantWrite Cloud Function Trigger
 * Fired whenever a tenant document is written (created, updated, deleted).
 * Synchronizes the 'role' field in Firestore to Custom Claims on the Auth User record.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

exports.onTenantWrite = functions.firestore
  .document("tenants/{phoneNumber}")
  .onWrite(async (change, context) => {
    const phone = context.params.phoneNumber;
    
    // Handle Document Deletion
    if (!change.after.exists) {
      functions.logger.log(`Tenant ${phone} deleted. Custom claims will be removed.`);
      try {
        const userRecord = await admin.auth().getUserByPhoneNumber(phone);
        await admin.auth().setCustomUserClaims(userRecord.uid, null);
        functions.logger.log(`Successfully removed custom claims for user ${userRecord.uid}`);
      } catch (err) {
        // User record might already be deleted
        functions.logger.error("Error clearing claims for deleted tenant:", err);
      }
      return null;
    }

    const data = change.after.data();
    const role = data.role || "resident";
    const uid = data.uid;

    if (!uid) {
      functions.logger.warn(`Tenant document ${phone} exists but does not contain a 'uid'. Claims cannot be set.`);
      return null;
    }

    // Check if role has changed or claims need to be initialized
    const beforeData = change.before.exists ? change.before.data() : null;
    if (beforeData && beforeData.role === role && beforeData.uid === uid) {
      // No change in role or uid, skip operation to avoid unnecessary API calls
      return null;
    }

    functions.logger.log(`Synchronizing custom claims for UID: ${uid}. Phone: ${phone}. New role: ${role}`);

    try {
      // Fetch current user claims
      const user = await admin.auth().getUser(uid);
      const currentClaims = user.customClaims || {};

      // Only update if claim is different
      if (currentClaims.role !== role) {
        await admin.auth().setCustomUserClaims(uid, {
          role: role,
          phone_number: phone // Denormalize phone number for Firestore rules lookup helper request.auth.token.phone_number
        });
        functions.logger.log(`Custom claims successfully set for ${uid}: { role: "${role}", phone_number: "${phone}" }`);
      }
    } catch (error) {
      functions.logger.error(`Failed to set custom user claims for ${uid}:`, error);
    }
    
    return null;
  });

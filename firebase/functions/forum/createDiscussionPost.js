/**
 * createDiscussionPost & createDiscussionReply Cloud Functions
 * Enables verified residents to start discussion threads and reply within their estate.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const db = admin.firestore();

// 1. CREATE DISCUSSION THREAD
exports.createDiscussionPost = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required to post.");
  }

  const { title, body } = data;
  if (!title || !body) {
    throw new functions.https.HttpsError("invalid-argument", "Posts must have a title and body.");
  }

  const myPhone = context.auth.token.phone_number;

  try {
    // Check if resident is verified
    const tenantSnap = await db.collection("tenants").doc(myPhone).get();
    if (!tenantSnap.exists || !tenantSnap.data().verified) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only verified residents can participate in discussions."
      );
    }

    const tenant = tenantSnap.data();
    const threadId = `disc_${Date.now()}`;
    const threadRef = db.collection("forum_discussions").doc(threadId);

    await threadRef.set({
      estateId: tenant.estateId,
      authorPhone: myPhone,
      title: title,
      body: body,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    functions.logger.log(`Created discussion thread ${threadId} for estate ${tenant.estateId}`);
    return { success: true, threadId };

  } catch (error) {
    functions.logger.error("Error creating discussion post:", error);
    throw new functions.https.HttpsError("internal", "Failed to create discussion post.");
  }
});

// 2. CREATE THREAD REPLY (SUB-COLLECTION WRITE)
exports.createDiscussionReply = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required to reply.");
  }

  const { threadId, body } = data;
  if (!threadId || !body) {
    throw new functions.https.HttpsError("invalid-argument", "Replies must reference a threadId and contain a body.");
  }

  const myPhone = context.auth.token.phone_number;

  try {
    // Check verification status
    const tenantSnap = await db.collection("tenants").doc(myPhone).get();
    if (!tenantSnap.exists || !tenantSnap.data().verified) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only verified residents can post replies."
      );
    }

    // Verify discussion thread exists
    const threadSnap = await db.collection("forum_discussions").doc(threadId).get();
    if (!threadSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Discussion thread not found.");
    }

    const replyId = `rep_${Date.now()}`;
    const replyRef = db.collection("forum_discussions").doc(threadId).collection("replies").doc(replyId);

    await replyRef.set({
      authorPhone: myPhone,
      body: body,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    functions.logger.log(`Created reply ${replyId} in thread ${threadId} by user ${myPhone}`);
    return { success: true, replyId };

  } catch (error) {
    functions.logger.error("Error creating discussion reply:", error);
    throw new functions.https.HttpsError("internal", "Failed to create reply: " + error.message);
  }
});

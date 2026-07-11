/**
 * createAnnouncement Callable Cloud Function
 * Restricted to users with Committee or Admin roles.
 * Creates an announcement for verified residents of their estate.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const db = admin.firestore();

exports.createAnnouncement = functions.https.onCall(async (data, context) => {
  // 1. Authenticated check
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign-in required to post announcements."
    );
  }

  const { title, body, pinned } = data;
  if (!title || !body) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Announcements must contain a valid 'title' and 'body'."
    );
  }

  const myPhone = context.auth.token.phone_number;
  const myRole = context.auth.token.role;

  // 2. Validate custom claims role: Committee or Admin
  if (myRole !== "committee" && myRole !== "admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Permission Denied. Only estate committee members or admins can post announcements."
    );
  }

  try {
    // 3. Fetch author's profile to get the estateId
    const authorSnap = await db.collection("tenants").doc(myPhone).get();
    if (!authorSnap.exists) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Author profile not found in database."
      );
    }

    const author = authorSnap.data();

    // 4. Write announcement document to Firestore
    const announcementId = `ann_${Date.now()}`;
    const announcementRef = db.collection("forum_announcements").doc(announcementId);

    const announcementData = {
      estateId: author.estateId,
      authorPhone: myPhone,
      title: title,
      body: body,
      pinned: pinned || false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await announcementRef.set(announcementData);
    functions.logger.log(`Created announcement ${announcementId} for Estate ${author.estateId} by ${myPhone}`);

    return {
      success: true,
      announcementId,
      message: "Announcement posted successfully."
    };

  } catch (error) {
    functions.logger.error("Error creating announcement:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to post announcement: " + error.message
    );
  }
});

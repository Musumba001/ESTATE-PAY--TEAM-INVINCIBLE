const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, FieldValue, normalizePhone, getCallerPhone } = require("./lib/firestoreHelpers");

/** createAnnouncement — committee/admin only. */
const createAnnouncement = onCall(async (request) => {
  const role = request.auth?.token?.role;
  if (role !== "committee" && role !== "admin") {
    throw new HttpsError("permission-denied", "Only committee members or admins can post announcements.");
  }

  const { title, body, pinned } = request.data || {};
  if (!title || !body) throw new HttpsError("invalid-argument", "title and body are required.");

  const estateId = request.auth.token.estateId;
  const authorPhone = getCallerPhone(request.auth);

  const ref = await db().collection("forum_announcements").add({
    estateId,
    authorPhone,
    title,
    body,
    pinned: !!pinned,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { announcementId: ref.id };
});

/** createDiscussionPost — any verified resident of the estate. */
const createDiscussionPost = onCall(async (request) => {
  const estateId = request.auth?.token?.estateId;
  const authorPhone = getCallerPhone(request.auth);
  if (!estateId || !authorPhone) {
    throw new HttpsError("permission-denied", "You must be a verified resident to post.");
  }

  const { title, body } = request.data || {};
  if (!title || !body) throw new HttpsError("invalid-argument", "title and body are required.");

  const ref = await db().collection("forum_discussions").add({
    estateId,
    authorPhone,
    title,
    body,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { discussionId: ref.id };
});

/** createReply — any verified resident of the same estate as the thread. */
const createReply = onCall(async (request) => {
  const estateId = request.auth?.token?.estateId;
  const authorPhone = getCallerPhone(request.auth);
  if (!estateId || !authorPhone) {
    throw new HttpsError("permission-denied", "You must be a verified resident to reply.");
  }

  const { threadId, body } = request.data || {};
  if (!threadId || !body) throw new HttpsError("invalid-argument", "threadId and body are required.");

  const threadSnap = await db().collection("forum_discussions").doc(threadId).get();
  if (!threadSnap.exists || threadSnap.data().estateId !== estateId) {
    throw new HttpsError("not-found", "Discussion thread not found.");
  }

  const ref = await threadSnap.ref.collection("replies").add({
    authorPhone,
    body,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { replyId: ref.id };
});

module.exports = { createAnnouncement, createDiscussionPost, createReply };

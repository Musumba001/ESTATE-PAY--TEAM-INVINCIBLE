/**
 * EstatePay Cloud Functions Entry Point
 */
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
// This is done once at startup and reused across all function invocations.
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// ---------------- AUTHENTICATION ----------------
const { resolveIdentity } = require("./auth/resolveIdentity");
const { onTenantWrite } = require("./auth/onTenantWrite");
exports.resolveIdentity = resolveIdentity;
exports.onTenantWrite = onTenantWrite;

// ---------------- WHATSAPP / TWILIO ----------------
const { whatsappWebhook } = require("./whatsapp/webhook");
exports.whatsappWebhook = whatsappWebhook;

// ---------------- PAYMENTS / M-PESA ----------------
const { initiateStkPush } = require("./payments/initiateStkPush");
const { mpesaCallback } = require("./payments/mpesaCallback");
exports.initiateStkPush = initiateStkPush;
exports.mpesaCallback = mpesaCallback;

// ---------------- BILLING ENGINE ----------------
const { generateMonthlyBills } = require("./billing/generateMonthlyBills");
exports.generateMonthlyBills = generateMonthlyBills;

// ---------------- COMMUNICATION FORUM ----------------
const { createAnnouncement } = require("./forum/createAnnouncement");
const { createDiscussionPost, createDiscussionReply } = require("./forum/createDiscussionPost");
exports.createAnnouncement = createAnnouncement;
exports.createDiscussionPost = createDiscussionPost;
exports.createDiscussionReply = createDiscussionReply;

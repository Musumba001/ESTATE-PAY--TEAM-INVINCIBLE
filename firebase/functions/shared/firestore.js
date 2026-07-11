/**
 * firestore.js Shared Client
 * Initializes Firestore DB instance if not already initialized.
 */
const admin = require("firebase-admin");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = db;

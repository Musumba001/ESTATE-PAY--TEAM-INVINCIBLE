/**
 * EstatePay Cloud Functions — entry point.
 * Firebase looks at this file's exports to know which functions to deploy.
 */

const { initializeApp } = require("firebase-admin/app");
initializeApp();

const identity = require("./src/identity");
const payments = require("./src/payments");
const billing = require("./src/billing");
const forum = require("./src/forum");
const whatsapp = require("./src/whatsapp");

module.exports = {
  // Identity & household
  resolveIdentity: identity.resolveIdentity,
  registerHousehold: identity.registerHousehold,
  generateHouseholdInvite: identity.generateHouseholdInvite,
  redeemHouseholdInvite: identity.redeemHouseholdInvite,
  onTenantWrite: identity.onTenantWrite,

  // Payments
  initiateStkPush: payments.initiateStkPush,
  mpesaCallback: payments.mpesaCallback,

  // Billing
  generateMonthlyBills: billing.generateMonthlyBills,
  runBillingNow: billing.runBillingNow,

  // Forum
  createAnnouncement: forum.createAnnouncement,
  createDiscussionPost: forum.createDiscussionPost,
  createReply: forum.createReply,

  // WhatsApp
  whatsappWebhook: whatsapp.whatsappWebhook,
};

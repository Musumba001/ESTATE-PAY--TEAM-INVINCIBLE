const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { db, FieldValue } = require("./lib/firestoreHelpers");

/**
 * Core billing logic, shared by the scheduled function and the manual
 * "Run Billing Engine" admin trigger.
 */
async function runMonthlyBillingCycle({ force = false } = {}) {
  const today = new Date();
  const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const estatesSnap = await db().collection("estates").get();
  let generatedCount = 0;

  for (const estateDoc of estatesSnap.docs) {
    const estate = estateDoc.data();
    if (!force && estate.billingDay && estate.billingDay !== today.getDate()) {
      // Skip estates not scheduled to bill today. This check only applies
      // to the automatic daily schedule — the manual "Run Billing Engine"
      // trigger passes force: true to bill immediately regardless of date.
      continue;
    }

    const unitsSnap = await estateDoc.ref.collection("units")
      .where("occupied", "==", true).get();

    for (const unitDoc of unitsSnap.docs) {
      const unit = unitDoc.data();
      if (!unit.currentTenantPhone) continue;

      // Skip if a bill for this unit/period already exists (idempotency).
      const existing = await db().collection("bills")
        .where("unitId", "==", unitDoc.id)
        .where("period", "==", period)
        .limit(1).get();
      if (!existing.empty) continue;

      const dueDate = new Date(today.getFullYear(), today.getMonth(), 20, 17, 0, 0);

      await db().collection("bills").add({
        tenantPhone: unit.currentTenantPhone,
        estateId: estateDoc.id,
        unitId: unitDoc.id,
        period,
        amount: unit.monthlyRate,
        amountPaid: 0,
        balance: unit.monthlyRate,
        status: "pending",
        dueDate,
        generatedAt: FieldValue.serverTimestamp(),
        paidTransactionId: null,
      });
      generatedCount++;
    }
  }

  logger.info(`Billing cycle complete for period ${period}. Generated ${generatedCount} bills.`);
  return { period, generatedCount };
}

/**
 * generateMonthlyBills — runs automatically every day at 08:00 Africa/Nairobi.
 * Each estate's own billingDay field decides whether it actually bills today.
 */
const generateMonthlyBills = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Africa/Nairobi" },
  async () => {
    await runMonthlyBillingCycle();
  }
);

/**
 * runBillingNow — manual admin-triggered callable version (e.g. an "Run
 * Billing Engine" button in the manager dashboard), for testing or
 * off-cycle billing. Restricted to admin custom claim.
 */
const runBillingNow = onCall(async (request) => {
  if (request.auth?.token?.role !== "admin") {
    throw new HttpsError("permission-denied", "Only estate admins can trigger billing manually.");
  }
  return runMonthlyBillingCycle({ force: true });
});

module.exports = { generateMonthlyBills, runBillingNow };
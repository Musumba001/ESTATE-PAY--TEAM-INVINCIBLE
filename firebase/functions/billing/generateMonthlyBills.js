/**
 * generateMonthlyBills Scheduled Cloud Function
 * Runs daily at midnight to traverse estates, identify matching billing days,
 * and batch-create new monthly bills for active units.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const db = admin.firestore();

// Runs daily at midnight
exports.generateMonthlyBills = functions.pubsub
  .schedule("0 0 * * *")
  .timeZone("Africa/Nairobi")
  .onRun(async (context) => {
    const today = new Date();
    const currentDay = today.getDate();
    
    // Period format: "YYYY-MM" (e.g., "2026-07")
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const currentPeriod = `${year}-${month}`;

    functions.logger.log(`Executing billing generation engine for Day: ${currentDay}. Period: ${currentPeriod}`);

    try {
      // 1. Query all estates whose billing day matches today
      const estatesSnap = await db.collection("estates")
        .where("billingDay", "==", currentDay)
        .get();

      if (estatesSnap.empty) {
        functions.logger.log("No estates matched today's billing day.");
        return null;
      }

      let billsGenerated = 0;
      const batch = db.batch();

      // 2. Loop through each matching estate
      for (const estateDoc of estatesSnap.docs) {
        const estateId = estateDoc.id;
        const estateData = estateDoc.data();

        functions.logger.log(`Processing billing for Estate: ${estateData.name} (${estateId})`);

        // 3. Query all units under the subcollection group
        const unitsSnap = await db.collection("estates").doc(estateId).collection("units").get();

        for (const unitDoc of unitsSnap.docs) {
          const unitId = unitDoc.id;
          const unit = unitDoc.data();

          // Generate bill if unit is occupied by a verified tenant
          if (unit.occupied && unit.currentTenantPhone) {
            const tenantPhone = unit.currentTenantPhone;

            // 4. Double billing check: Make sure a bill for this tenant+period doesn't already exist
            const existingBillQuery = await db.collection("bills")
              .where("tenantPhone", "==", tenantPhone)
              .where("period", "==", currentPeriod)
              .limit(1)
              .get();

            if (existingBillQuery.empty) {
              const newBillId = `bill_${estateId}_${unitId}_${currentPeriod}`;
              const billRef = db.collection("bills").doc(newBillId);

              const dueDate = new Date();
              dueDate.setDate(dueDate.getDate() + 15); // due in 15 days by default

              batch.set(billRef, {
                tenantPhone: tenantPhone,
                estateId: estateId,
                unitId: unitId,
                period: currentPeriod,
                amount: unit.monthlyRate,
                status: "pending",
                dueDate: admin.firestore.Timestamp.fromDate(dueDate),
                generatedAt: admin.firestore.FieldValue.serverTimestamp(),
                paidTransactionId: null
              });

              billsGenerated++;
            }
          }
        }
      }

      // 5. Commit all document creations in a single atomic transaction
      if (billsGenerated > 0) {
        await batch.commit();
        functions.logger.log(`Billing trigger successfully generated ${billsGenerated} new bills for Period ${currentPeriod}`);
      } else {
        functions.logger.log("No new bills needed to be generated.");
      }

    } catch (error) {
      functions.logger.error("Error executing monthly billing scheduler:", error);
    }

    return null;
  });

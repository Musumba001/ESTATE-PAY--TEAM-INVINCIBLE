/**
 * mpesaCallback HTTPS Webhook Callback Endpoint
 * Receives transaction completion payloads asynchronously from Safaricom Daraja API,
 * updates Firestore documents, and triggers notifications.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { generateReceiptAndNotify } = require("./receipts");

const db = admin.firestore();

exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  // Validate POST request method
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const callbackData = req.body.Body;
    if (!callbackData || !callbackData.stkCallback) {
      functions.logger.warn("Invalid callback payload format received.");
      res.status(400).send({ ResultCode: 1, ResultDesc: "Invalid Payload" });
      return;
    }

    const stkCallback = callbackData.stkCallback;
    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    functions.logger.log(`Received M-Pesa Callback for Checkout: ${checkoutRequestId}. Code: ${resultCode} (${resultDesc})`);

    // 1. Fetch matching transaction document from Firestore (O(N) simulated where query)
    const txnQuery = await db.collection("transactions")
      .where("mpesaCheckoutRequestId", "==", checkoutRequestId)
      .limit(1)
      .get();

    if (txnQuery.empty) {
      functions.logger.warn(`No matching transaction found in database for checkout: ${checkoutRequestId}`);
      res.status(200).send({ ResultCode: 0, ResultDesc: "Ignored: No matching transaction" });
      return;
    }

    const txnDoc = txnQuery.docs[0];
    const txnData = txnDoc.data();
    const isSuccess = resultCode === 0;

    if (isSuccess) {
      // 2. Parse Safaricom Callback Metadata Array values
      const metadataItems = stkCallback.CallbackMetadata.Item;
      const receiptNumberItem = metadataItems.find(item => item.Name === "MpesaReceiptNumber");
      const receiptNumber = receiptNumberItem ? receiptNumberItem.Value : `MPESA_${Date.now()}`;

      // 3. Perform atomic batch update for Transaction and Bill state documents
      const batch = db.batch();

      // Update Transaction status to success
      batch.update(txnDoc.ref, {
        status: "success",
        mpesaReceiptNumber: receiptNumber,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update Bill status to paid
      const billRef = db.collection("bills").doc(txnData.billId);
      batch.update(billRef, {
        status: "paid",
        paidTransactionId: txnDoc.id
      });

      await batch.commit();
      functions.logger.log(`Firestore updated successfully: Transaction ${txnDoc.id} & Bill ${txnData.billId} marked PAID.`);

      // 4. Generate digital receipts and push notification to the user channel
      try {
        await generateReceiptAndNotify(txnData, receiptNumber);
      } catch (notifyErr) {
        functions.logger.error("Failed to generate receipt/notifications:", notifyErr);
      }

    } else {
      // User cancelled STK push or entered wrong PIN
      await txnDoc.ref.update({
        status: "failed",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      functions.logger.log(`Transaction ${txnDoc.id} marked failed. Safaricom reason: ${resultDesc}`);
    }

    // Safaricom expects a success code 0 response
    res.status(200).send({ ResultCode: 0, ResultDesc: "Success" });

  } catch (error) {
    functions.logger.error("Error processing Safaricom callback:", error);
    res.status(500).send({ ResultCode: 1, ResultDesc: "Internal Server Error" });
  }
});

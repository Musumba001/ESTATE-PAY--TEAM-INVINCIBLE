const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { db, FieldValue, normalizePhone, AppError, getCallerPhone } = require("./lib/firestoreHelpers");
const daraja = require("./lib/daraja");
const secrets = require("./lib/secrets");

/**
 * initiateStkPush — starts a Lipa na M-Pesa Online (STK Push) payment for a
 * given bill. Callable from the app (or from the WhatsApp webhook handler
 * directly, without going through onCall, since that's server-to-server).
 */
const initiateStkPush = onCall(
  {
    secrets: [
      secrets.MPESA_CONSUMER_KEY,
      secrets.MPESA_CONSUMER_SECRET,
      secrets.MPESA_SHORTCODE,
      secrets.MPESA_PASSKEY,
      secrets.MPESA_CALLBACK_URL,
    ],
  },
  async (request) => {
    const callerPhone = getCallerPhone(request.auth);
    if (!callerPhone) throw new HttpsError("invalid-argument", "You must be signed in.");

    const { billId, payAmount, channel } = request.data || {};
    if (!billId) throw new HttpsError("invalid-argument", "billId is required.");

    try {
      const result = await initiateStkPushInternal({
        billId,
        phone: callerPhone,
        payAmount,
        channel: channel || "app",
      });
      return result;
    } catch (err) {
      logger.error("initiateStkPush failed:", err?.response?.data || err);
      if (err instanceof AppError) throw new HttpsError("invalid-argument", err.message);
      throw new HttpsError("internal", "Failed to initiate M-Pesa payment. Please try again.");
    }
  }
);

/**
 * Internal helper (not an exported Cloud Function) so the WhatsApp webhook
 * can trigger a payment without going through the onCall auth wrapper.
 */
async function initiateStkPushInternal({ billId, phone, payAmount, channel }) {
  const billRef = db().collection("bills").doc(billId);
  const billSnap = await billRef.get();
  if (!billSnap.exists) throw new AppError("not-found", "Bill not found.");
  const bill = billSnap.data();

  // If the caller specifies an amount, honor it exactly (this allows paying
  // ahead / overpaying into credit even when the bill is already settled).
  // Only when no amount is given do we default to "pay off the balance" —
  // which requires an actual positive balance to make sense.
  let amount;
  if (payAmount && payAmount > 0) {
    amount = payAmount;
  } else {
    if (bill.balance <= 0) {
      throw new AppError("invalid-argument", "This bill has no outstanding balance — enter an amount to pay in advance instead.");
    }
    amount = bill.balance;
  }

  const accessToken = await daraja.getAccessToken(
    secrets.MPESA_CONSUMER_KEY.value(),
    secrets.MPESA_CONSUMER_SECRET.value()
  );

  const stkResponse = await daraja.stkPush({
    accessToken,
    shortcode: secrets.MPESA_SHORTCODE.value(),
    passkey: secrets.MPESA_PASSKEY.value(),
    phone,
    amount,
    accountReference: bill.unitId,
    callbackUrl: secrets.MPESA_CALLBACK_URL.value(),
    description: "EstatePay Bill",
  });

  if (stkResponse.ResponseCode !== "0") {
    throw new AppError("invalid-argument", stkResponse.ResponseDescription || "M-Pesa rejected the request.");
  }

  const txnRef = db().collection("transactions").doc();
  await txnRef.set({
    billId,
    tenantPhone: phone,
    amount,
    mpesaCheckoutRequestId: stkResponse.CheckoutRequestID,
    mpesaMerchantRequestId: stkResponse.MerchantRequestID,
    mpesaReceiptNumber: null,
    status: "pending",
    channel,
    initiatedAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });

  return {
    transactionId: txnRef.id,
    checkoutRequestId: stkResponse.CheckoutRequestID,
    customerMessage: stkResponse.CustomerMessage,
  };
}

/**
 * mpesaCallback — public HTTPS endpoint that Safaricom Daraja calls when the
 * customer completes (or cancels/fails) the STK Push PIN prompt.
 *
 * IMPORTANT: Safaricom does not sign callbacks the way Twilio does. Treat
 * this endpoint as public and validate everything by looking up the
 * CheckoutRequestID against a transaction WE created — never trust amounts
 * or identifiers blindly. For extra protection, consider restricting this
 * endpoint's IP allowlist via Cloud Armor / API Gateway in production.
 */
const mpesaCallback = onRequest(async (req, res) => {
  try {
    const parsed = daraja.parseStkCallback(req.body);
    if (!parsed) {
      logger.warn("mpesaCallback: unrecognized payload shape", req.body);
      res.status(400).send("Bad Request");
      return;
    }

    const txnQuery = await db().collection("transactions")
      .where("mpesaCheckoutRequestId", "==", parsed.checkoutRequestId)
      .limit(1).get();

    if (txnQuery.empty) {
      logger.warn(`mpesaCallback: no matching transaction for checkoutRequestId ${parsed.checkoutRequestId}`);
      // Still return 200 so Safaricom doesn't retry forever.
      res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      return;
    }

    const txnDoc = txnQuery.docs[0];
    const txn = txnDoc.data();

    if (txn.status !== "pending") {
      // Already processed — respond OK and stop, to be idempotent.
      res.status(200).json({ ResultCode: 0, ResultDesc: "Already processed" });
      return;
    }

    await db().runTransaction(async (tx) => {
      const billRef = db().collection("bills").doc(txn.billId);
      const billSnap = await tx.get(billRef);
      if (!billSnap.exists) return;
      const bill = billSnap.data();

      if (!parsed.success) {
        tx.update(txnDoc.ref, {
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          failureReason: parsed.resultDesc,
        });
        return;
      }

      const newAmountPaid = (bill.amountPaid || 0) + txn.amount;
      const newBalance = bill.amount - newAmountPaid; // can go negative — that's a credit, not clamped to 0

      tx.update(billRef, {
        amountPaid: newAmountPaid,
        balance: newBalance,
        status: newBalance <= 0 ? "paid" : "pending",
        paidTransactionId: newBalance <= 0 ? txnDoc.id : bill.paidTransactionId || null,
      });

      tx.update(txnDoc.ref, {
        status: "success",
        mpesaReceiptNumber: parsed.mpesaReceiptNumber,
        completedAt: FieldValue.serverTimestamp(),
      });
    });

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    logger.error("mpesaCallback error:", err);
    // Still 200 — Safaricom will keep retrying on non-200, which can create
    // duplicate side effects if the error was on our side after partial work.
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

module.exports = { initiateStkPush, initiateStkPushInternal, mpesaCallback };

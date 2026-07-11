/**
 * initiateStkPush Callable Cloud Function
 * Authenticates user claim, makes HTTP API request to Safaricom Daraja v1 processrequest,
 * and saves transaction log.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const { getDarajaAccessToken, buildLipaNaMpesaPassword, getTimestamp } = require("../shared/mpesaClient");

const db = admin.firestore();

exports.initiateStkPush = functions.https.onCall(async (data, context) => {
  // 1. Force Firebase Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign-in required to execute bill payment."
    );
  }

  const { billId, channel } = data;
  if (!billId) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Function must be called with a valid 'billId'."
    );
  }

  // 2. Fetch bill record from database
  const billRef = db.collection("bills").doc(billId);
  const billSnap = await billRef.get();
  
  if (!billSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Bill document not found.");
  }
  
  const bill = billSnap.data();

  // 3. Ensure bill is unpaid
  if (bill.status === "paid") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This bill has already been paid."
    );
  }

  // 4. Authorize: Only the tenant themselves or an admin can initiate payment
  const myPhone = context.auth.token.phone_number;
  const myRole = context.auth.token.role;
  if (bill.tenantPhone !== myPhone && myRole !== "admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Unauthorized. You can only pay your own bills."
    );
  }

  try {
    // 5. Build Safaricom API credentials
    const token = await getDarajaAccessToken();
    const timestamp = getTimestamp();
    const password = buildLipaNaMpesaPassword(timestamp);

    const amount = Math.round(bill.amount);
    const shortcode = process.env.MPESA_SHORTCODE || "174379"; // Lipa Na Mpesa Sandbox Code
    const callbackUrl = `${process.env.FUNCTIONS_BASE_URL || "https://us-central1-estatepay-f81d2.cloudfunctions.net"}/mpesaCallback`;

    // 6. Make STK Push POST Request to Safaricom API
    functions.logger.log(`Triggering Safaricom STK Push for ${bill.tenantPhone}. Amount: ${amount}`);
    const stkResponse = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: bill.tenantPhone.replace("+", ""),
        PartyB: shortcode,
        PhoneNumber: bill.tenantPhone.replace("+", ""),
        CallBackURL: callbackUrl,
        AccountReference: bill.unitId,
        TransactionDesc: `EstatePay Bill ${bill.period}`
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    // 7. Record checkout attempt in transactions audit log
    const checkoutRequestId = stkResponse.data.CheckoutRequestID;
    const txnRef = db.collection("transactions").doc();
    await txnRef.set({
      billId,
      tenantPhone: bill.tenantPhone,
      amount: bill.amount,
      mpesaCheckoutRequestId: checkoutRequestId,
      status: "initiated",
      channel: channel || "app",
      initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: null
    });

    return {
      success: true,
      checkoutRequestId: checkoutRequestId,
      message: "STK Push sent. Please enter your M-Pesa PIN on your phone to complete payment."
    };

  } catch (error) {
    functions.logger.error("Error initiating STK push:", error.response ? error.response.data : error.message);
    throw new functions.https.HttpsError(
      "internal",
      "M-Pesa payment gateway error: " + (error.response ? JSON.stringify(error.response.data) : error.message)
    );
  }
});

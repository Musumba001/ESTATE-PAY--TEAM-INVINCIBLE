/**
 * Safaricom Daraja (M-Pesa) integration.
 * Docs: https://developer.safaricom.co.ke/Documentation
 *
 * Uses the sandbox host by default. Swap DARAJA_HOST to the production host
 * once you have production credentials approved by Safaricom.
 */

const axios = require("axios");

const DARAJA_HOST = process.env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

/** Fetches an OAuth access token using Consumer Key/Secret (Basic Auth). */
async function getAccessToken(consumerKey, consumerSecret) {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const res = await axios.get(
    `${DARAJA_HOST}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

/** Builds the Daraja Lipa na M-Pesa timestamp format: yyyyMMddHHmmss */
function darajaTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Initiates an STK Push (Lipa na M-Pesa Online) prompt on the payer's phone.
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.shortcode - Business shortcode (paybill/till)
 * @param {string} opts.passkey
 * @param {string} opts.phone - E.164 phone, will be converted to 2547XXXXXXXX
 * @param {number} opts.amount
 * @param {string} opts.accountReference - e.g. house number
 * @param {string} opts.callbackUrl
 * @param {string} opts.description
 */
async function stkPush({ accessToken, shortcode, passkey, phone, amount, accountReference, callbackUrl, description }) {
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  const msisdn = phone.replace("+", "");

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: msisdn,
    PartyB: shortcode,
    PhoneNumber: msisdn,
    CallBackURL: callbackUrl,
    AccountReference: accountReference.slice(0, 12),
    TransactionDesc: (description || "EstatePay Bill").slice(0, 13),
  };

  const res = await axios.post(
    `${DARAJA_HOST}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  // Response includes MerchantRequestID, CheckoutRequestID, ResponseCode, CustomerMessage
  return res.data;
}

/**
 * Parses the raw Daraja callback body into a normalized shape.
 * See: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate (callback structure)
 */
function parseStkCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;

  const base = {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    success: cb.ResultCode === 0,
  };

  if (base.success && cb.CallbackMetadata?.Item) {
    const items = {};
    for (const item of cb.CallbackMetadata.Item) {
      items[item.Name] = item.Value;
    }
    base.amount = items.Amount;
    base.mpesaReceiptNumber = items.MpesaReceiptNumber;
    base.transactionDate = items.TransactionDate;
    base.phoneNumber = items.PhoneNumber;
  }

  return base;
}

module.exports = { getAccessToken, stkPush, parseStkCallback };

/**
 * mpesaClient.js M-Pesa API client helper
 * Handles Daraja OAuth tokens and password generations.
 */
const axios = require("axios");

// Simple in-memory token cache to prevent hitting Daraja rate limits
let tokenCache = {
  token: null,
  expiry: 0
};

/**
 * getDarajaAccessToken
 * Fetches token from Safaricom oauth/v1/generate endpoint.
 * Requires MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET environment variables.
 */
async function getDarajaAccessToken() {
  const now = Date.now();
  
  // Use cached token if still valid
  if (tokenCache.token && tokenCache.expiry > now) {
    return tokenCache.token;
  }

  const consumerKey = process.env.MPESA_CONSUMER_KEY || "mockKey";
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET || "mockSecret";
  
  // If in local debug emulator without variables, return dummy token
  if (consumerKey === "mockKey") {
    return "MOCK_DARAJA_ACCESS_TOKEN";
  }

  const authHeader = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const response = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${authHeader}`
      }
    }
  );

  const token = response.data.access_token;
  const expiresIn = parseInt(response.data.expires_in) * 1000; // seconds to ms
  
  // Cache the token (subtracting 60 seconds buffer)
  tokenCache = {
    token: token,
    expiry: now + expiresIn - 60000
  };

  return token;
}

/**
 * getTimestamp
 * Returns time string in the format YYYYMMDDHHMMSS as required by Safaricom Daraja API.
 */
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  
  return `${year}${month}${date}${hours}${minutes}${seconds}`;
}

/**
 * buildLipaNaMpesaPassword
 * Safaricom Lipa Na M-Pesa password signature generation:
 * Base64(Shortcode + Passkey + Timestamp)
 */
function buildLipaNaMpesaPassword(timestamp) {
  const shortcode = process.env.MPESA_SHORTCODE || "174379";
  const passkey = process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"; // Lipa na Mpesa Sandbox Passkey
  
  const rawSignature = `${shortcode}${passkey}${timestamp}`;
  return Buffer.from(rawSignature).toString("base64");
}

module.exports = {
  getDarajaAccessToken,
  getTimestamp,
  buildLipaNaMpesaPassword
};

/**
 * phone.js Phone Normalization Helpers
 */

/**
 * normalizePhone
 * Strips 'whatsapp:' prefix and normalizes number format to E.164 (e.g. +254XXXXXXXXX).
 */
function normalizePhone(phoneStr) {
  if (!phoneStr) return "";
  
  // Strip Twilio channel identifier (e.g. "whatsapp:+254712345678" -> "+254712345678")
  let cleanPhone = phoneStr.replace("whatsapp:", "").trim();
  
  // Format as E.164
  if (!cleanPhone.startsWith("+")) {
    if (cleanPhone.startsWith("0")) {
      // Assuming Kenyan phone number format by default (07XXXXXXXX -> +2547XXXXXXXX)
      cleanPhone = `+254${cleanPhone.slice(1)}`;
    } else {
      cleanPhone = `+${cleanPhone}`;
    }
  }
  
  return cleanPhone;
}

module.exports = {
  normalizePhone
};

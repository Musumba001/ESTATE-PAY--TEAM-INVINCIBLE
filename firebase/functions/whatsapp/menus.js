/**
 * WhatsApp Text menus layout rendering module.
 * Formats data from Firestore into text layouts for WhatsApp display.
 */
const admin = require("firebase-admin");
const db = admin.firestore();

// Formats a numbered list of available estates
async function renderEstateMenu() {
  const estatesSnap = await db.collection("estates").orderBy("createdAt", "asc").get();
  if (estatesSnap.empty) {
    return "No estates available on the system. Please contact the administrator.";
  }

  let text = "🏢 *Select your Nairobi Estate*:\n\n";
  let index = 1;
  
  // Save array index to match numbers to IDs
  estatesSnap.forEach(doc => {
    const data = doc.data();
    text += `${index}. *${data.name}* (${data.location})\n`;
    index++;
  });
  text += "\nReply with the estate number to select.";
  return text;
}

// Formats available house numbers scoped to an estate sub-collection
async function renderUnitMenu(estateId) {
  const unitsSnap = await db.collection("estates").doc(estateId).collection("units").get();
  if (unitsSnap.empty) {
    return "No house units registered under this estate.";
  }

  let text = "🏠 *Select your House Unit*:\n\n";
  let index = 1;
  
  unitsSnap.forEach(doc => {
    const data = doc.data();
    const status = data.occupied ? "Occupied" : "Vacant";
    text += `${index}. House *${data.houseNumber}* (Rate: KES ${data.monthlyRate}/mo - ${status})\n`;
    index++;
  });
  text += "\nReply with the unit number to select.";
  return text;
}

// Static Main menu options list
function renderMainMenu() {
  return "📋 *EstatePay Main Menu*:\n\n1. 💵 My Bill\n2. 💬 Estate Forum\n0. Restart";
}

// Static Forum options list
function renderForumMenu() {
  return "💬 *Estate Forum*:\n\n1. 📢 View Announcements\n2. ✍️ Post to Discussions\n0. Back to Main Menu";
}

// Formats active unpaid bills invoice
async function renderBillSummary(phoneNumber) {
  const billsSnap = await db.collection("bills")
    .where("tenantPhone", "==", phoneNumber)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (billsSnap.empty) {
    return "✅ *Your Bills*:\n\nYou have no outstanding bills at this time. All payments are up to date!";
  }

  const bill = billsSnap.docs[0].data();
  const dueDateStr = bill.dueDate ? new Date(bill.dueDate.toDate()).toLocaleDateString() : "N/A";
  
  return `💵 *Outstanding Bill Summary*:\n\n` +
         `Period: *${bill.period}*\n` +
         `Amount Due: *KES ${bill.amount.toLocaleString()}*\n` +
         `Due Date: *${dueDateStr}*\n` +
         `Status: *Unpaid*\n\n` +
         `Reply *1* to trigger payment request via Safaricom M-Pesa STK Push.`;
}

// Formats announcements scoped to an estate (pins appear first)
async function renderAnnouncements(estateId) {
  const annSnap = await db.collection("forum_announcements")
    .where("estateId", "==", estateId)
    .orderBy("pinned", "desc")
    .orderBy("createdAt", "desc")
    .limit(5)
    .get();

  if (annSnap.empty) {
    return "📢 *Announcements*:\n\nNo announcements recorded for this estate. Reply *0* to return.";
  }

  let text = `📢 *Announcements*:\n\n`;
  annSnap.forEach(doc => {
    const ann = doc.data();
    const dateStr = ann.createdAt ? new Date(ann.createdAt.toDate()).toLocaleDateString() : "";
    text += `${ann.pinned ? '📌 *[PINNED]* ' : ''}*${ann.title}*\n${ann.body}\n_Posted on ${dateStr}_\n\n`;
  });
  text += "Reply *0* to return to the Main Menu.";
  return text;
}

module.exports = {
  renderEstateMenu,
  renderUnitMenu,
  renderMainMenu,
  renderForumMenu,
  renderBillSummary,
  renderAnnouncements
};

// backend/scripts/set-school-whatsapp-number.js
//
// Attaches a dedicated WhatsApp Phone Number ID to a school, once that
// number has gone through Meta's setup (OTP verified, display name
// approved, PIN set - see docs/WHATSAPP_SETUP_CHECKLIST.md).
//
// Usage (from backend/ directory):
//   node scripts/set-school-whatsapp-number.js

require('dotenv').config();
const readline = require('readline');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

async function main() {
  console.log('=== Elimu Smart: Attach Dedicated WhatsApp Number to a School ===\n');

  const db = admin.firestore();

  const churchesSnap = await db.collection('schools').get();
  if (churchesSnap.empty) {
    console.error('No schools found. Run scripts/create-first-admin.js first.');
    process.exit(1);
  }

  console.log('Existing schools:');
  churchesSnap.docs.forEach((doc) => {
    console.log(`  - ${doc.id}  (${doc.data().name})`);
  });

  const schoolId = (await ask('\nChurch ID to update: ')).trim();
  const churchDoc = await db.collection('schools').doc(schoolId).get();

  if (!churchDoc.exists) {
    console.error(`No school found with ID "${schoolId}".`);
    process.exit(1);
  }

  const phoneNumberId = (await ask('WhatsApp Phone Number ID (from Meta API Setup): ')).trim();
  const displayNumber = (await ask('Display phone number, for reference (e.g. +2547XXXXXXXX): ')).trim();

  if (!phoneNumberId) {
    console.error('Phone Number ID is required.');
    process.exit(1);
  }

  rl.close();

  await db.collection('schools').doc(schoolId).update({
    whatsappPhoneNumberId: phoneNumberId,
    whatsappDisplayNumber: displayNumber || null,
    whatsappConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`\n✓ ${churchDoc.data().name} is now connected to WhatsApp number ${displayNumber || phoneNumberId}`);
  console.log('  Level 3 (automated broadcast) will now work for this school,');
  console.log('  as long as the message template is approved.');

  process.exit(0);
}

main().catch((err) => {
  console.error('\nScript failed:', err.message);
  process.exit(1);
});

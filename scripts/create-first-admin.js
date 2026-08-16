// backend/scripts/create-first-admin.js
//
// One-off setup script: creates a school doc in Firestore, then a Firebase
// Auth admin user linked to it via the `schoolId` custom claim.
//
// Usage (from backend/ directory, after .env is filled in):
//   node scripts/create-first-admin.js
//
// It will prompt for school name, admin email, and admin password.
// Requires the same env vars as server.js (FIREBASE_PROJECT_ID, etc).

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

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  console.log('=== Elimu Smart: Create First School + Admin ===\n');

  const schoolName = (await ask('School name: ')).trim();
  if (!schoolName) {
    console.error('School name is required.');
    process.exit(1);
  }

  const suggestedId = slugify(schoolName);
  const schoolIdInput = (await ask(`School ID [${suggestedId}]: `)).trim();
  const schoolId = schoolIdInput || suggestedId;

  const adminEmail = (await ask('Admin email: ')).trim();
  const adminPassword = await ask('Admin password (min 6 chars): ');

  if (!adminEmail || !adminPassword || adminPassword.length < 6) {
    console.error('Valid email and a password of at least 6 characters are required.');
    process.exit(1);
  }

  rl.close();

  const db = admin.firestore();

  // 1. Create (or overwrite) the school document
  await db.collection('schools').doc(schoolId).set({
    name: schoolName,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\n✓ School created: schools/${schoolId}`);

  // 2. Create the Auth user (or reuse if it already exists)
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      emailVerified: false,
    });
    console.log(`✓ Admin user created: ${userRecord.uid}`);
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      userRecord = await admin.auth().getUserByEmail(adminEmail);
      console.log(`✓ Admin user already existed, reusing: ${userRecord.uid}`);
    } else {
      throw err;
    }
  }

  // 3. Set the schoolId + role custom claims so API requests are scoped correctly.
  // The first account created for a school is always the admin (full access).
  // Use scripts/create-team-member.js afterward to add teacher accounts.
  await admin.auth().setCustomUserClaims(userRecord.uid, { schoolId, role: 'admin' });
  console.log(`✓ Custom claim set: { schoolId: "${schoolId}", role: "admin" }`);

  console.log('\nDone. Log in to admin.html with:');
  console.log(`  Email: ${adminEmail}`);
  console.log(`  Password: (what you entered)`);
  console.log('\nNote: custom claims take effect on the user\'s NEXT login/token refresh,');
  console.log('so if this account was already logged in anywhere, log out and back in.');

  process.exit(0);
}

main().catch((err) => {
  console.error('\nScript failed:', err.message);
  process.exit(1);
});

// backend/scripts/create-team-member.js
//
// Creates an admin or teacher account for an EXISTING school, with the
// correct role + (for teachers) classId custom claims.
//
// Use this to hand a school over to its real admin after you've done
// the initial setup - just add them as "admin" here, then either stop
// using your own account for that school or keep it as a support login.
//
// For the very FIRST account on a brand new school (which also creates the
// school itself), use scripts/create-first-admin.js instead.
//
// Usage (from backend/ directory):
//   node scripts/create-team-member.js

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
  console.log('=== Elimu Smart: Create Admin or Teacher Account ===\n');

  const db = admin.firestore();

  const schoolsSnap = await db.collection('schools').get();
  if (schoolsSnap.empty) {
    console.error('No schools found. Run scripts/create-first-admin.js first.');
    process.exit(1);
  }

  console.log('Existing schools:');
  schoolsSnap.docs.forEach((doc) => {
    console.log('  - ' + doc.id + '  (' + doc.data().name + ')');
  });

  const schoolId = (await ask('\nSchool ID: ')).trim();
  const schoolDoc = await db.collection('schools').doc(schoolId).get();
  if (!schoolDoc.exists) {
    console.error('No school found with ID "' + schoolId + '".');
    process.exit(1);
  }

  const roleInput = (await ask('Role - "admin" or "teacher": ')).trim().toLowerCase();
  if (roleInput !== 'admin' && roleInput !== 'teacher') {
    console.error('Role must be exactly "admin" or "teacher".');
    process.exit(1);
  }

  let classId = null;
  if (roleInput === 'teacher') {
    const classesSnap = await db.collection('schools').doc(schoolId).collection('classes').get();
    if (classesSnap.empty) {
      console.error('This school has no classes yet. Add a class first in admin.html.');
      process.exit(1);
    }
    console.log('\nClasses in this school:');
    classesSnap.docs.forEach((doc) => {
      console.log('  - ' + doc.id + '  (' + doc.data().name + ')');
    });
    classId = (await ask('\nClass ID this teacher belongs to: ')).trim();

    const classDoc = await db.collection('schools').doc(schoolId).collection('classes').doc(classId).get();
    if (!classDoc.exists) {
      console.error('No class found with ID "' + classId + '" in this school.');
      process.exit(1);
    }
  }

  const email = (await ask('\nAccount email: ')).trim();
  const password = await ask('Account password (min 6 chars): ');

  if (!email || !password || password.length < 6) {
    console.error('Valid email and a password of at least 6 characters are required.');
    process.exit(1);
  }

  rl.close();

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, password, emailVerified: false });
    console.log('\n✓ Account created: ' + userRecord.uid);
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      userRecord = await admin.auth().getUserByEmail(email);
      console.log('\n✓ Account already existed, reusing: ' + userRecord.uid);
    } else {
      throw err;
    }
  }

  const claims = { schoolId, role: roleInput };
  if (classId) claims.classId = classId;

  await admin.auth().setCustomUserClaims(userRecord.uid, claims);
  console.log('✓ Custom claims set: ' + JSON.stringify(claims));

  console.log('\nDone. This account can now log in to admin.html with:');
  console.log('  Email: ' + email);
  console.log('  Password: (what you entered)');
  console.log('  Role: ' + roleInput + (classId ? ' (scoped to class: ' + classId + ')' : ' (full access)'));
  console.log('\nNote: custom claims take effect on the NEXT login/token refresh.');

  process.exit(0);
}

main().catch((err) => {
  console.error('\nScript failed:', err.message);
  process.exit(1);
});

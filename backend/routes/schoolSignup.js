// backend/routes/schoolSignup.js
// Public route (NO requireAuth) - this is how a brand new school gets
// onto Elimu Smart with zero involvement from Softica. Anyone with the
// shareable school-signup.html link can register their own school and
// become its first admin.
//
// This is intentionally open (no invite token, unlike teacher signup) -
// the whole point is true self-service so a donation-model rollout to
// many schools doesn't bottleneck on one person running scripts.

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = () => admin.firestore();

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// Finds a schoolId that doesn't collide with an existing one, appending
// -2, -3, etc if the base slug is already taken.
async function findAvailableChurchId(baseSlug) {
  let candidate = baseSlug || 'school';
  let suffix = 1;

  while (true) {
    const doc = await db().collection('schools').doc(candidate).get();
    if (!doc.exists) return candidate;
    suffix += 1;
    candidate = baseSlug + '-' + suffix;
  }
}

// POST /api/school-signup/register  { schoolName, email, password }
router.post('/register', async (req, res) => {
  try {
    const { schoolName, email, password } = req.body;

    if (!schoolName || !schoolName.trim()) {
      return res.status(400).json({ error: 'School name is required' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const baseSlug = slugify(schoolName);
    const schoolId = await findAvailableChurchId(baseSlug);

    // Create the Firebase Auth account first - if the email is already
    // taken, fail before creating the school doc so we don't leave an
    // orphaned school with no working admin account.
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({ email, password, emailVerified: false });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return res.status(400).json({ error: 'An account with this email already exists. Try logging in instead, or use a different email.' });
      }
      throw err;
    }

    await db().collection('schools').doc(schoolId).set({
      name: schoolName.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdVia: 'self-service-signup',
    });

    await admin.auth().setCustomUserClaims(userRecord.uid, {
      schoolId: schoolId,
      role: 'admin',
    });

    res.json({ success: true, schoolId: schoolId, schoolName: schoolName.trim() });
  } catch (err) {
    console.error('School registration failed:', err.message);
    res.status(500).json({ error: 'Failed to register your school. Please try again.' });
  }
});

module.exports = router;

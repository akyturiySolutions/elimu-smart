// backend/routes/teacherSignup.js
// Public routes (NO requireAuth) - a teacher hasn't got an account yet, so
// there's nothing to authenticate. The invite token itself (from a link
// the admin generated and sent) is what proves they were actually
// invited, not a schoolId/classId guessed out of thin air.
//
// Flow: admin clicks "Generate Teacher Invite" on a class (classes.js
// POST /:id/invite) -> shares the resulting link via WhatsApp -> teacher
// opens it, picks their own email + password -> account created here with
// the correct schoolId/role/classId custom claims already attached, no
// script, no admin involvement beyond sending the link.

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = () => admin.firestore();

// GET /api/teacher-signup/validate?school=schoolId&token=token
router.get('/validate', async (req, res) => {
  try {
    const { school: schoolId, token } = req.query;
    if (!schoolId || !token) {
      return res.status(400).json({ valid: false, error: 'Missing school or token' });
    }

    const inviteDoc = await db()
      .collection('schools').doc(schoolId)
      .collection('leaderInvites').doc(token).get();

    if (!inviteDoc.exists) {
      return res.json({ valid: false, error: 'This invite link is not valid.' });
    }

    const invite = inviteDoc.data();

    if (invite.used) {
      return res.json({ valid: false, error: 'This invite link has already been used.' });
    }

    if (invite.expiresAt.toDate() < new Date()) {
      return res.json({ valid: false, error: 'This invite link has expired. Ask your admin for a new one.' });
    }

    res.json({ valid: true, className: invite.className });
  } catch (err) {
    console.error('Validate invite failed:', err.message);
    res.status(500).json({ valid: false, error: 'Something went wrong checking this invite.' });
  }
});

// POST /api/teacher-signup/complete  { school, token, email, password }
router.post('/complete', async (req, res) => {
  try {
    const { school: schoolId, token, email, password } = req.body;

    if (!schoolId || !token || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const inviteRef = db()
      .collection('schools').doc(schoolId)
      .collection('leaderInvites').doc(token);
    const inviteDoc = await inviteRef.get();

    if (!inviteDoc.exists) {
      return res.status(400).json({ error: 'This invite link is not valid.' });
    }
    const invite = inviteDoc.data();

    if (invite.used) {
      return res.status(400).json({ error: 'This invite link has already been used.' });
    }
    if (invite.expiresAt.toDate() < new Date()) {
      return res.status(400).json({ error: 'This invite link has expired. Ask your admin for a new one.' });
    }

    // Create the Firebase Auth account. If the email is already taken by
    // some OTHER account, refuse rather than silently reassigning it.
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({ email, password, emailVerified: false });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return res.status(400).json({ error: 'An account with this email already exists. Try logging in instead, or use a different email.' });
      }
      throw err;
    }

    await admin.auth().setCustomUserClaims(userRecord.uid, {
      schoolId,
      role: 'teacher',
      classId: invite.classId,
    });

    await inviteRef.update({
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      usedByEmail: email,
    });

    res.json({ success: true, className: invite.className });
  } catch (err) {
    console.error('Complete teacher signup failed:', err.message);
    res.status(500).json({ error: 'Failed to create your account. Please try again.' });
  }
});

module.exports = router;

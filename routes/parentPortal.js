// backend/routes/parentPortal.js
// Parent-facing endpoints. NO AUTHENTICATION - parent identifies themselves
// by phone number alone, no OTP/SMS verification (removed by product
// decision to avoid Firebase Blaze billing + SMS friction for parents).
//
// SECURITY TRADEOFF: anyone who knows or guesses a parent's phone number
// can view that parent's class, teacher name/phone, and open the actual
// WhatsApp group invite link. There is no proof-of-ownership check here.
// If this becomes a problem later, middleware/parentAuth.js still exists
// and can be re-added to these routes to restore OTP verification.
//
// School context comes from a `school` query param (the portal URL is
// expected to be school-specific, e.g. portal.html?school=<schoolId>).

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = () => admin.firestore();

// Phone numbers may be stored as 07XXXXXXXX or 254XXXXXXXXX depending on
// how they were entered - build both candidate forms so lookup works
// either way without a data migration.
function phoneCandidates(digits) {
  const d = (digits || '').replace(/\D/g, '');
  const intl = d.startsWith('0') ? '254' + d.slice(1) : d;
  const local = d.startsWith('254') ? '0' + d.slice(3) : d;
  return [...new Set([intl, local, d])];
}

async function findMemberByPhone(schoolId, phone) {
  const candidates = phoneCandidates(phone);
  const parentsRef = db().collection('schools').doc(schoolId).collection('parents');

  let snap = await parentsRef.where('phone', 'in', candidates).limit(1).get();
  if (snap.empty) {
    snap = await parentsRef.where('whatsappNumber', 'in', candidates).limit(1).get();
  }
  if (snap.empty) return null;

  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// GET /api/portal/me?school=schoolId&phone=07XXXXXXXX
router.get('/me', async (req, res) => {
  try {
    const { school: schoolId, phone } = req.query;
    if (!schoolId) return res.status(400).json({ error: 'school query param is required' });
    if (!phone) return res.status(400).json({ error: 'phone query param is required' });

    const parent = await findMemberByPhone(schoolId, phone);
    if (!parent) {
      return res.status(404).json({
        error: 'No parent record found for this phone number. Please contact your school admin.',
      });
    }

    let classInfo = null;
    if (parent.classId) {
      const classDoc = await db()
        .collection('schools').doc(schoolId)
        .collection('classes').doc(parent.classId).get();
      if (classDoc.exists) classInfo = { id: classDoc.id, ...classDoc.data() };
    }

    res.json({ parent, class: classInfo });
  } catch (err) {
    console.error('Portal /me failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch your profile' });
  }
});

// POST /api/portal/join-group?school=schoolId  { phone: "07XXXXXXXX" }
// Marks whatsappStatus as 'joined' when the parent taps the Join Group
// button. Elimu Smart doesn't verify they actually joined (WhatsApp gives
// no API for that) - this is just a self-reported status for the teacher's
// visibility. Without OTP, this is also self-reported by an UNVERIFIED
// phone number - treat whatsappStatus as a loose signal, not a fact.
router.post('/join-group', async (req, res) => {
  try {
    const { school: schoolId } = req.query;
    const { phone } = req.body;
    if (!schoolId) return res.status(400).json({ error: 'school query param is required' });
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const parent = await findMemberByPhone(schoolId, phone);
    if (!parent) return res.status(404).json({ error: 'Parent record not found' });

    await db()
      .collection('schools').doc(schoolId)
      .collection('parents').doc(parent.id)
      .update({ whatsappStatus: 'joined', updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ success: true });
  } catch (err) {
    console.error('Portal join-group failed:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;

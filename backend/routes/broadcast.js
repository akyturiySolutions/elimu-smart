// backend/routes/broadcast.js
// "Send to my class" - sends the same message individually (1:1) to every
// parent of a class via WhatsApp Cloud API. Logs results to Firestore so
// teachers can see who received it.

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth, blockReadOnlyRoles, requireOwnClass } = require('../middleware/auth');
const { sendTemplateMessage } = require('../services/whatsapp');

const router = express.Router();
const db = () => admin.firestore();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /api/broadcast/class/:classId  { message: string }
// admin: any class. teacher: only their own.
router.post('/class/:classId', requireAuth, blockReadOnlyRoles, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { schoolId } = req;
    const { classId } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const churchDoc = await db().collection('schools').doc(schoolId).get();
    const phoneNumberId = churchDoc.data()?.whatsappPhoneNumberId;

    if (!phoneNumberId) {
      return res.status(400).json({
        error: 'No WhatsApp number is set up for this school yet. Run scripts/set-school-whatsapp-number.js first.',
      });
    }

    const parentsSnap = await db()
      .collection('schools').doc(schoolId)
      .collection('parents').where('classId', '==', classId).get();

    if (parentsSnap.empty) {
      return res.status(404).json({ error: 'No parents found in this class' });
    }

    const results = [];

    // Sequential with a small delay to stay well under Cloud API rate limits.
    for (const doc of parentsSnap.docs) {
      const parent = doc.data();
      if (!parent.phone) {
        results.push({ parentId: doc.id, success: false, error: 'No phone on file' });
        continue;
      }
      const result = await sendTemplateMessage(phoneNumberId, parent.phone, message.trim());
      results.push({ parentId: doc.id, name: parent.name, ...result });
      await sleep(150);
    }

    const successCount = results.filter((r) => r.success).length;

    await db()
      .collection('schools').doc(schoolId)
      .collection('broadcasts').add({
        classId,
        message: message.trim(),
        sentBy: req.user.uid,
        successCount,
        failCount: results.length - successCount,
        results,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ sent: successCount, failed: results.length - successCount, results });
  } catch (err) {
    console.error('Broadcast failed:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// GET /api/broadcast/class/:classId/history - last 20 broadcasts for a class
router.get('/class/:classId/history', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const snap = await db()
      .collection('schools').doc(req.schoolId)
      .collection('broadcasts')
      .where('classId', '==', req.params.classId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const history = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ history });
  } catch (err) {
    console.error('Broadcast history failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcast history' });
  }
});

module.exports = router;

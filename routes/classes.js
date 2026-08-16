// backend/routes/classes.js
// Class CRUD, scoped to the requesting user's schoolId.
// Firestore path: schools/{schoolId}/classes/{classId}
//
// Role rules:
//   admin   - full CRUD on all classes
//   teacher - can list/view only their own class; cannot create/delete classes,
//             CAN update their own class (e.g. to add a WhatsApp group link)
//
// whatsappGroupLink is the Level 1 feature: a chat.whatsapp.com invite link
// the admin (or teacher, for their own class) pastes in once — this is the
// class-teacher WhatsApp group parents belong to. Elimu Smart never creates
// or manages the actual WhatsApp group itself.

const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { requireAuth, blockReadOnlyRoles, requireOwnClass } = require('../middleware/auth');

const router = express.Router();
const db = () => admin.firestore();

// GET /api/classes - list classes for this school (teachers only see their own class)
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = db().collection('schools').doc(req.schoolId).collection('classes');

    if (req.role === 'teacher') {
      if (!req.classId) return res.json({ classes: [] });
      const doc = await query.doc(req.classId).get();
      return res.json({ classes: doc.exists ? [{ id: doc.id, ...doc.data() }] : [] });
    }

    const snap = await query.orderBy('name').get();
    const classes = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ classes });
  } catch (err) {
    console.error('List classes failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

// POST /api/classes - create (admin only - teachers can't create new classes)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.role !== 'admin') {
      return res.status(403).json({ error: 'Only secretaries can create classes' });
    }

    const { name, teacherName, teacherPhone, meetingDay, meetingTime, location, whatsappGroupLink } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    const classData = {
      name,
      teacherName: teacherName || '',
      teacherPhone: teacherPhone || '',
      meetingDay: meetingDay || '',
      meetingTime: meetingTime || '',
      location: location || '',
      whatsappGroupLink: whatsappGroupLink || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Track when the group link was set, so teachers/admin can see at a
    // glance whether it might be stale (e.g. teacher made a new group and
    // forgot to update it here).
    if (whatsappGroupLink) {
      classData.whatsappGroupLinkUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    const ref = await db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').add(classData);

    res.status(201).json({ id: ref.id, ...classData });
  } catch (err) {
    console.error('Create class failed:', err.message);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

// PUT /api/classes/:id - update (admin: any class. teacher: only their own)
router.put('/:id', requireAuth, blockReadOnlyRoles, requireOwnClass((req) => req.params.id), async (req, res) => {
  try {
    const classRef = db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(req.params.id);

    const doc = await classRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Class not found' });

    const existing = doc.data();
    const updates = { ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    // Only stamp the link-updated timestamp when the link value actually
    // changes - re-saving the form without touching the link shouldn't
    // make it look freshly updated.
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'whatsappGroupLink') &&
      req.body.whatsappGroupLink !== existing.whatsappGroupLink
    ) {
      updates.whatsappGroupLinkUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await classRef.update(updates);
    res.json({ id: req.params.id, ...existing, ...updates });
  } catch (err) {
    console.error('Update class failed:', err.message);
    res.status(500).json({ error: 'Failed to update class' });
  }
});

// DELETE /api/classes/:id - admin only
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (req.role !== 'admin') {
      return res.status(403).json({ error: 'Only secretaries can delete classes' });
    }

    const classRef = db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(req.params.id);

    const doc = await classRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Class not found' });

    await classRef.delete();
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Delete class failed:', err.message);
    res.status(500).json({ error: 'Failed to delete class' });
  }
});

// POST /api/classes/:id/invite - admin only
// Generates a one-time, expiring token a teacher can use to self-register
// for THIS specific class, without the admin running any script.
router.post('/:id/invite', requireAuth, async (req, res) => {
  try {
    if (req.role !== 'admin') {
      return res.status(403).json({ error: 'Only secretaries can generate teacher invites' });
    }

    const classDoc = await db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(req.params.id).get();

    if (!classDoc.exists) return res.status(404).json({ error: 'Class not found' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db()
      .collection('schools').doc(req.schoolId)
      .collection('leaderInvites').doc(token)
      .set({
        classId: req.params.id,
        className: classDoc.data().name,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        used: false,
      });

    res.json({ token, className: classDoc.data().name });
  } catch (err) {
    console.error('Generate invite failed:', err.message);
    res.status(500).json({ error: 'Failed to generate invite' });
  }
});

module.exports = router;

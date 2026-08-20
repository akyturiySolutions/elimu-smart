// backend/routes/parents.js
// Parent CRUD, scoped to the requesting admin's schoolId.
// Firestore path: schools/{schoolId}/parents/{parentId}
//
// Role rules:
//   admin - full CRUD on all parents
//   teacher    - can list/view/create/update/delete ONLY parents in their own class

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth, blockReadOnlyRoles } = require('../middleware/auth');

const router = express.Router();
const db = () => admin.firestore();

// GET /api/parents  - list parents for this school (teachers forced to their own class)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { schoolId } = req;
    let { classId } = req.query;

    // Teachers can only ever see their own class's parents, regardless of what
    // classId they pass in the query string.
    if (req.role === 'teacher') {
      if (!req.classId) return res.json({ parents: [] });
      classId = req.classId;
    }

    let query = db().collection('schools').doc(schoolId).collection('parents');
    if (classId) query = query.where('classId', '==', classId);

    const snap = await query.orderBy('name').get();
    const parents = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ parents });
  } catch (err) {
    console.error('List parents failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch parents' });
  }
});

// GET /api/parents/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const doc = await db()
      .collection('schools').doc(req.schoolId)
      .collection('parents').doc(req.params.id).get();

    if (!doc.exists) return res.status(404).json({ error: 'Parent not found' });

    const parent = doc.data();
    if (req.role === 'teacher' && parent.classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only access parents in their own class' });
    }

    res.json({ id: doc.id, ...parent });
  } catch (err) {
    console.error('Get parent failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch parent' });
  }
});

// POST /api/parents  - create (admin: any class. teacher: only their own)
router.post('/', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    const { name, phone, whatsappNumber, classId, joinedDate, notes, childName } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    if (req.role === 'teacher' && classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only add parents to their own class' });
    }

    const parentData = {
      name,
      childName: childName || '', // the pupil's name - what turns the class list into an actual roll call
      phone,
      // Defaults to phone if not set separately - most parents use the same
      // number for calls/SMS and WhatsApp, but this lets you override.
      whatsappNumber: whatsappNumber || phone,
      whatsappStatus: 'not_invited', // not_invited | invited | joined
      classId: classId || null,
      joinedDate: joinedDate || new Date().toISOString().slice(0, 10),
      notes: notes || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db()
      .collection('schools').doc(req.schoolId)
      .collection('parents').add(parentData);

    res.status(201).json({ id: ref.id, ...parentData });
  } catch (err) {
    console.error('Create parent failed:', err.message);
    res.status(500).json({ error: 'Failed to create parent' });
  }
});

// PUT /api/parents/:id  - update
router.put('/:id', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    const parentRef = db()
      .collection('schools').doc(req.schoolId)
      .collection('parents').doc(req.params.id);

    const doc = await parentRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Parent not found' });

    const existing = doc.data();
    if (req.role === 'teacher' && existing.classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only update parents in their own class' });
    }

    const { name, phone, whatsappNumber, whatsappStatus, classId, joinedDate, notes, childName } = req.body;

    // A teacher moving a parent OUT of their own class would effectively let
    // them edit a parent they'd lose visibility of - block cross-class moves
    // for teachers; admin already covers the rest.
    if (req.role === 'teacher' && classId !== undefined && classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers cannot move parents to a different class' });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (childName !== undefined) updates.childName = childName;
    if (phone !== undefined) updates.phone = phone;
    if (whatsappNumber !== undefined) updates.whatsappNumber = whatsappNumber;
    if (whatsappStatus !== undefined) updates.whatsappStatus = whatsappStatus;
    if (classId !== undefined) updates.classId = classId;
    if (joinedDate !== undefined) updates.joinedDate = joinedDate;
    if (notes !== undefined) updates.notes = notes;
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await parentRef.update(updates);
    res.json({ id: req.params.id, ...existing, ...updates });
  } catch (err) {
    console.error('Update parent failed:', err.message);
    res.status(500).json({ error: 'Failed to update parent' });
  }
});

// DELETE /api/parents/:id
router.delete('/:id', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    const parentRef = db()
      .collection('schools').doc(req.schoolId)
      .collection('parents').doc(req.params.id);

    const doc = await parentRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Parent not found' });

    const existing = doc.data();
    if (req.role === 'teacher' && existing.classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only delete parents in their own class' });
    }

    await parentRef.delete();
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Delete parent failed:', err.message);
    res.status(500).json({ error: 'Failed to delete parent' });
  }
});

// POST /api/parents/bulk  { classId, parents: [{ name, phone }, ...] }
// Creates many parents in one request - built for onboarding an existing
// WhatsApp group's participant list in one paste instead of one form
// submission per person. Uses a single Firestore batch write.
router.post('/bulk', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    const { classId, parents } = req.body;

    if (!Array.isArray(parents) || parents.length === 0) {
      return res.status(400).json({ error: 'parents array is required' });
    }
    if (parents.length > 300) {
      return res.status(400).json({ error: 'Please add at most 300 parents at a time' });
    }

    if (req.role === 'teacher' && classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only add parents to their own class' });
    }

    const validMembers = parents.filter((m) => m && m.name && m.phone);
    const skipped = parents.length - validMembers.length;

    if (validMembers.length === 0) {
      return res.status(400).json({ error: 'No valid parents found - each line needs at least a name and phone' });
    }

    const batch = db().batch();
    const parentsCollection = db()
      .collection('schools').doc(req.schoolId)
      .collection('parents');

    validMembers.forEach((m) => {
      const ref = parentsCollection.doc();
      batch.set(ref, {
        name: m.name,
        phone: m.phone,
        whatsappNumber: m.phone,
        whatsappStatus: 'not_invited',
        classId: classId || null,
        joinedDate: new Date().toISOString().slice(0, 10),
        notes: '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();

    res.json({ created: validMembers.length, skipped: skipped });
  } catch (err) {
    console.error('Bulk create parents failed:', err.message);
    res.status(500).json({ error: 'Failed to bulk-add parents' });
  }
});

module.exports = router;

// backend/routes/lessonPlans.js
// Lesson plan CRUD, scoped to the requesting user's schoolId.
// Firestore path: schools/{schoolId}/lessonPlans/{lessonPlanId}
//
// Role rules:
//   teacher - create/read/update/delete own plans only, and only while status === 'draft'.
//             Once submitted, a teacher can no longer edit or delete it - only an
//             admin's status change can send it back to 'draft'.
//   admin   - read all plans (review queue), change status (draft/submitted/approved),
//             leave a reviewNote. Admin "delete" is a soft-delete (sets deletedAt),
//             never a real delete - see class/homework audit-trail reasoning already
//             established for [[elimu]] (mirrors backend/routes/classes.js conventions).
//
// Status flow: draft -> submitted -> approved (or back to draft for revision).
// Homework can only reference a lessonPlanId once that plan's status is 'approved'
// (enforced in routes/homework.js, not here).

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const db = () => admin.firestore();

const VALID_STATUSES = ['draft', 'submitted', 'approved'];

// Merges globalCurriculum + this school's curriculumOverrides for one template,
// same "effectiveTemplate = { ...global, ...override }" merge we designed earlier.
async function getEffectiveTemplate(schoolId, templateId) {
  if (!templateId) return null;

  const [globalDoc, overrideDoc] = await Promise.all([
    db().collection('globalCurriculum').doc(templateId).get(),
    db().collection('schools').doc(schoolId).collection('curriculumOverrides').doc(templateId).get(),
  ]);

  if (!globalDoc.exists) return null;

  const base = globalDoc.data();
  const override = overrideDoc.exists ? overrideDoc.data().overriddenFields || {} : {};
  return { id: templateId, ...base, ...override };
}

// GET /api/lesson-plans - list (teachers see only their own; admin sees all,
// with optional ?classId=&teacherId=&term=&status= filters for the review queue)
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = db().collection('schools').doc(req.schoolId).collection('lessonPlans');

    if (req.role === 'teacher') {
      query = query.where('teacherId', '==', req.user.uid);
    } else {
      // admin - optional filters for the review queue
      if (req.query.classId) query = query.where('classId', '==', req.query.classId);
      if (req.query.teacherId) query = query.where('teacherId', '==', req.query.teacherId);
      if (req.query.term) query = query.where('term', '==', req.query.term);
      if (req.query.status) query = query.where('status', '==', req.query.status);
    }

    // exclude soft-deleted plans unless explicitly asked for
    if (req.query.includeDeleted !== 'true') {
      query = query.where('deletedAt', '==', null);
    }

    const snap = await query.get();
    const lessonPlans = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ lessonPlans });
  } catch (err) {
    console.error('List lesson plans failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch lesson plans' });
  }
});

// GET /api/lesson-plans/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const ref = db().collection('schools').doc(req.schoolId).collection('lessonPlans').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Lesson plan not found' });

    const data = doc.data();
    if (req.role === 'teacher' && data.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only access their own lesson plans' });
    }

    res.json({ lessonPlan: { id: doc.id, ...data } });
  } catch (err) {
    console.error('Get lesson plan failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch lesson plan' });
  }
});

// POST /api/lesson-plans - create (teacher only, own class; always starts as draft)
// If templateId is given, prefills learningOutcomes/keyInquiryQuestions/coreCompetencies
// from the effective (global + school override) curriculum template.
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers create lesson plans' });
    }

    const { classId, term, week, date, subject, strand, subStrand, templateId,
            objectives, lessonActivities, resources, assessmentMethod } = req.body;

    if (!classId || !term || !subject) {
      return res.status(400).json({ error: 'classId, term, and subject are required' });
    }

    if (classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only create lesson plans for their own class' });
    }

    let prefill = {};
    if (templateId) {
      const template = await getEffectiveTemplate(req.schoolId, templateId);
      if (template) {
        prefill = {
          learningOutcomes: template.learningOutcomes || [],
          keyInquiryQuestions: template.keyInquiryQuestions || [],
          coreCompetencies: template.coreCompetencies || [],
        };
      }
    }

    const lessonPlanData = {
      teacherId: req.user.uid,
      classId,
      templateId: templateId || null,
      term,
      week: week || null,
      date: date || null,
      subject,
      strand: strand || '',
      subStrand: subStrand || '',
      objectives: objectives || prefill.learningOutcomes || [],
      keyInquiryQuestions: prefill.keyInquiryQuestions || [],
      coreCompetencies: prefill.coreCompetencies || [],
      lessonActivities: lessonActivities || [],
      resources: resources || [],
      assessmentMethod: assessmentMethod || '',
      status: 'draft',
      reviewNote: '',
      deletedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db()
      .collection('schools').doc(req.schoolId)
      .collection('lessonPlans').add(lessonPlanData);

    res.status(201).json({ id: ref.id, ...lessonPlanData });
  } catch (err) {
    console.error('Create lesson plan failed:', err.message);
    res.status(500).json({ error: 'Failed to create lesson plan' });
  }
});

// PUT /api/lesson-plans/:id
// Teacher: can edit own plan's content, only while status is still 'draft'.
//          Cannot change status via this route (submit is a separate action - see below).
// Admin: can change status (draft/submitted/approved) and set reviewNote.
//        Cannot edit plan content or reassign teacherId.
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const ref = db().collection('schools').doc(req.schoolId).collection('lessonPlans').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Lesson plan not found' });

    const existing = doc.data();
    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (req.role === 'teacher') {
      if (existing.teacherId !== req.user.uid) {
        return res.status(403).json({ error: 'Teachers can only edit their own lesson plans' });
      }
      if (existing.status !== 'draft') {
        return res.status(403).json({ error: 'Lesson plan is locked from teacher edits once submitted' });
      }

      const editable = ['term', 'week', 'date', 'subject', 'strand', 'subStrand',
                         'objectives', 'lessonActivities', 'resources', 'assessmentMethod'];
      editable.forEach((field) => {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      });
    } else {
      // admin: status transitions + review note only
      if (req.body.status !== undefined) {
        if (!VALID_STATUSES.includes(req.body.status)) {
          return res.status(400).json({ error: 'status must be one of: ' + VALID_STATUSES.join(', ') });
        }
        updates.status = req.body.status;
      }
      if (req.body.reviewNote !== undefined) updates.reviewNote = req.body.reviewNote;
    }

    await ref.update(updates);
    const updatedDoc = await ref.get();
    res.json({ id: updatedDoc.id, ...updatedDoc.data() });
  } catch (err) {
    console.error('Update lesson plan failed:', err.message);
    res.status(500).json({ error: 'Failed to update lesson plan' });
  }
});

// POST /api/lesson-plans/:id/submit - teacher only, own draft plan -> submitted
// Separate from PUT so a teacher can never accidentally self-approve via a stray field.
router.post('/:id/submit', requireAuth, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers submit lesson plans' });
    }

    const ref = db().collection('schools').doc(req.schoolId).collection('lessonPlans').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Lesson plan not found' });

    const existing = doc.data();
    if (existing.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only submit their own lesson plans' });
    }
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only a draft lesson plan can be submitted' });
    }

    await ref.update({ status: 'submitted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, id: req.params.id, status: 'submitted' });
  } catch (err) {
    console.error('Submit lesson plan failed:', err.message);
    res.status(500).json({ error: 'Failed to submit lesson plan' });
  }
});

// DELETE /api/lesson-plans/:id
// Teacher: real delete, only their own, only while still 'draft'.
// Admin: soft-delete only (sets deletedAt) - never a real delete, preserves the
// audit trail once a plan has ever been submitted/approved (same reasoning as
// class/parent records elsewhere in this codebase).
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ref = db().collection('schools').doc(req.schoolId).collection('lessonPlans').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Lesson plan not found' });

    const existing = doc.data();

    if (req.role === 'teacher') {
      if (existing.teacherId !== req.user.uid) {
        return res.status(403).json({ error: 'Teachers can only delete their own lesson plans' });
      }
      if (existing.status !== 'draft') {
        return res.status(403).json({ error: 'Only a draft lesson plan can be deleted' });
      }
      await ref.delete();
      return res.json({ success: true, id: req.params.id, hardDeleted: true });
    }

    // admin - soft delete only
    await ref.update({ deletedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, id: req.params.id, hardDeleted: false });
  } catch (err) {
    console.error('Delete lesson plan failed:', err.message);
    res.status(500).json({ error: 'Failed to delete lesson plan' });
  }
});

module.exports = router;

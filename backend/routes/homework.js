// backend/routes/homework.js
// Homework CRUD + AI/OCR flow, scoped to the requesting user's schoolId.
// Firestore path: schools/{schoolId}/homework/{homeworkId}
//
// Flow (as designed for [[elimu]]):
//   1. Teacher photographs a handwritten note -> POST /ocr (Claude transcribes)
//   2. POST /structure turns the raw OCR text into subject/instructions/
//      dueDate/materials (Gemini 2.0 Flash) - teacher reviews/edits before
//      anything is saved; nothing is auto-published at this stage.
//   3. POST / creates the homework record as a draft. lessonPlanId is
//      required and must point to a lesson plan with status 'approved' -
//      enforces the same gate as the Firestore rules.
//   4. POST /:id/publish sends it to the class's parent WhatsApp group via
//      the same sendTemplateMessage path broadcast.js uses, and flips
//      status to 'published'.
//
// Role rules: teacher only (create/edit/publish/delete, own class only).
// Admin can read everything for oversight, same as lessonPlans.js.

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth, blockReadOnlyRoles, requireOwnClass } = require('../middleware/auth');
const { transcribeHomeworkImage } = require('../services/ocrClaude');
const { structureHomeworkText } = require('../services/aiStructureGemini');
const { sendTemplateMessage } = require('../services/whatsapp');
const { uploadHomeworkImage } = require('../services/storage');

const router = express.Router();
const db = () => admin.firestore();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /api/homework/ocr  { imageBase64, mediaType }
// Teacher only. Returns { text, confidence } on success.
// On low confidence, returns 422 so the frontend can show "retake photo"
// instead of a mostly-blank review form - see services/ocrClaude.js for
// the confidence heuristic.
router.post('/ocr', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can use the homework OCR tool' });
    }

    const { imageBase64, mediaType } = req.body;
    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: 'imageBase64 and mediaType are required' });
    }

    const result = await transcribeHomeworkImage(imageBase64, mediaType);

    if (result.confidence === 'low') {
      return res.status(422).json({
        error: 'Could not read this note clearly enough. Please retake the photo with better lighting or a steadier shot.',
        confidence: 'low',
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Homework OCR failed:', err.message);
    res.status(500).json({ error: 'Failed to process the image' });
  }
});

// POST /api/homework/structure  { rawText }
// Teacher only. Turns raw OCR (or manually typed) text into structured fields.
router.post('/structure', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can use this tool' });
    }

    const { rawText } = req.body;
    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ error: 'rawText is required' });
    }

    const structured = await structureHomeworkText(rawText.trim());
    res.json(structured);
  } catch (err) {
    console.error('Homework structuring failed:', err.message);
    res.status(500).json({ error: 'Failed to structure the text' });
  }
});

// GET /api/homework - list (teacher: own only; admin: all, with optional
// ?classId=&status= filters for oversight)
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = db().collection('schools').doc(req.schoolId).collection('homework');

    if (req.role === 'teacher') {
      query = query.where('teacherId', '==', req.user.uid);
    } else {
      if (req.query.classId) query = query.where('classId', '==', req.query.classId);
      if (req.query.status) query = query.where('status', '==', req.query.status);
    }

    const snap = await query.get();
    const homework = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ homework });
  } catch (err) {
    console.error('List homework failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch homework' });
  }
});

// GET /api/homework/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const ref = db().collection('schools').doc(req.schoolId).collection('homework').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Homework not found' });

    const data = doc.data();
    if (req.role === 'teacher' && data.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only access their own homework' });
    }

    res.json({ homework: { id: doc.id, ...data } });
  } catch (err) {
    console.error('Get homework failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch homework' });
  }
});

// POST /api/homework - create draft (teacher only, own class, requires an
// APPROVED lesson plan - same gate as the Firestore rules we designed earlier)
router.post('/', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers create homework' });
    }

    const { classId, lessonPlanId, subject, instructions, dueDate, materials,
            sourceType, originalImageBase64, originalImageMediaType } = req.body;

    if (!classId || !lessonPlanId || !instructions) {
      return res.status(400).json({ error: 'classId, lessonPlanId, and instructions are required' });
    }
    if (classId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only create homework for their own class' });
    }

    const lessonPlanDoc = await db()
      .collection('schools').doc(req.schoolId)
      .collection('lessonPlans').doc(lessonPlanId).get();

    if (!lessonPlanDoc.exists || lessonPlanDoc.data().status !== 'approved') {
      return res.status(400).json({ error: 'Homework must be linked to an approved lesson plan' });
    }

    // Photo goes to Firebase Storage, not inline in the Firestore document -
    // avoids the 1MB Firestore document limit (a real phone photo, once
    // base64-inflated, can exceed that on its own) and keeps homework list
    // reads from dragging full images along with them every time.
    let originalImageUrl = null;
    let originalImageStoragePath = null;
    if (sourceType === 'ocr' && originalImageBase64) {
      try {
        const uploaded = await uploadHomeworkImage(
          req.schoolId,
          originalImageBase64,
          originalImageMediaType || 'image/jpeg',
        );
        originalImageUrl = uploaded.url;
        originalImageStoragePath = uploaded.storagePath;
      } catch (uploadErr) {
        console.error('Homework image upload failed:', uploadErr.message);
        return res.status(500).json({ error: 'Failed to save the photo. Please try again.' });
      }
    }

    const homeworkData = {
      teacherId: req.user.uid,
      classId,
      lessonPlanId,
      subStrand: lessonPlanDoc.data().subStrand || '', // inherited for analytics roll-up
      subject: subject || lessonPlanDoc.data().subject || '',
      instructions,
      dueDate: dueDate || null,
      materials: materials || [],
      sourceType: sourceType === 'ocr' ? 'ocr' : 'manual',
      originalImageUrl,
      originalImageStoragePath,
      status: 'draft',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db()
      .collection('schools').doc(req.schoolId)
      .collection('homework').add(homeworkData);

    res.status(201).json({ id: ref.id, ...homeworkData });
  } catch (err) {
    console.error('Create homework failed:', err.message);
    res.status(500).json({ error: 'Failed to create homework' });
  }
});

// PUT /api/homework/:id - edit (teacher only, own, only while draft)
router.put('/:id', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers edit homework' });
    }

    const ref = db().collection('schools').doc(req.schoolId).collection('homework').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Homework not found' });

    const existing = doc.data();
    if (existing.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only edit their own homework' });
    }
    if (existing.status !== 'draft') {
      return res.status(403).json({ error: 'Homework is locked from edits once published' });
    }

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    ['subject', 'instructions', 'dueDate', 'materials'].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    await ref.update(updates);
    const updatedDoc = await ref.get();
    res.json({ id: updatedDoc.id, ...updatedDoc.data() });
  } catch (err) {
    console.error('Update homework failed:', err.message);
    res.status(500).json({ error: 'Failed to update homework' });
  }
});

// POST /api/homework/:id/publish - teacher only, own draft homework.
// Sends the instructions to every parent in the class via WhatsApp
// (same 1:1 template-send pattern as broadcast.js), then flips to 'published'.
router.post('/:id/publish', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers publish homework' });
    }

    const ref = db().collection('schools').doc(req.schoolId).collection('homework').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Homework not found' });

    const homework = doc.data();
    if (homework.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only publish their own homework' });
    }
    if (homework.status !== 'draft') {
      return res.status(400).json({ error: 'Only a draft can be published' });
    }

    const schoolDoc = await db().collection('schools').doc(req.schoolId).get();
    const phoneNumberId = schoolDoc.data()?.whatsappPhoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({
        error: 'No WhatsApp number is set up for this school yet. Run scripts/set-school-whatsapp-number.js first.',
      });
    }

    const parentsSnap = await db()
      .collection('schools').doc(req.schoolId)
      .collection('parents').where('classId', '==', homework.classId).get();

    // Include a direct link to the original scanned photo (Firebase Storage
    // signed URL) in the text message body, rather than sending it as an
    // actual WhatsApp image attachment. This deliberately avoids needing a
    // second Meta-approved template with an image header - the message uses
    // the SAME already-approved text template as every other broadcast.
    // Parent taps the link and sees the note (diagrams included) in their
    // browser. No extra Meta review, no extra cost, no new dependency.
    //
    // sendHomeworkImageMessage() in services/whatsapp.js sends a true inline
    // WhatsApp image instead of a link, and is kept ready to use if a proper
    // image-header template ever gets approved later - just swap which
    // branch runs below.
    const messageBody = `Homework - ${homework.subject || 'Class'}: ${homework.instructions}` +
      (homework.dueDate ? `\nDue: ${homework.dueDate}` : '') +
      (homework.originalImageUrl ? `\nView the actual note (with any diagrams): ${homework.originalImageUrl}` : '');

    const results = [];
    for (const parentDoc of parentsSnap.docs) {
      const parent = parentDoc.data();
      if (!parent.phone) {
        results.push({ parentId: parentDoc.id, success: false, error: 'No phone on file' });
        continue;
      }

      const result = await sendTemplateMessage(phoneNumberId, parent.phone, messageBody);
      results.push({ parentId: parentDoc.id, name: parent.name, ...result });
      await sleep(150);
    }

    const successCount = results.filter((r) => r.success).length;

    await ref.update({
      status: 'published',
      publishedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, id: req.params.id, status: 'published', sent: successCount, failed: results.length - successCount, results });
  } catch (err) {
    console.error('Publish homework failed:', err.message);
    res.status(500).json({ error: 'Failed to publish homework' });
  }
});

// DELETE /api/homework/:id - teacher only, own, only while draft
router.delete('/:id', requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers delete homework' });
    }

    const ref = db().collection('schools').doc(req.schoolId).collection('homework').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Homework not found' });

    const existing = doc.data();
    if (existing.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Teachers can only delete their own homework' });
    }
    if (existing.status !== 'draft') {
      return res.status(403).json({ error: 'Only a draft can be deleted' });
    }

    await ref.delete();

    // Clean up the Storage file too, so deleted drafts don't leave orphaned
    // images behind. Best-effort - a failure here shouldn't block the
    // delete response, since the Firestore record is already gone.
    if (existing.originalImageStoragePath) {
      try {
        await admin.storage().bucket().file(existing.originalImageStoragePath).delete();
      } catch (storageErr) {
        console.error('Homework image cleanup failed (non-fatal):', storageErr.message);
      }
    }

    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Delete homework failed:', err.message);
    res.status(500).json({ error: 'Failed to delete homework' });
  }
});

module.exports = router;

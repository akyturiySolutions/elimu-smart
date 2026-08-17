// backend/routes/analytics.js
// Class analytics, scoped to the requesting user's schoolId.
//
// Scope decision (deliberate, not an oversight): this tracks homework
// COVERAGE - how many homework items have been assigned per CBC sub-strand
// and subject for a class/term - not completion rates. There is no
// parent-facing "mark as done" mechanism built yet, so a completion-rate
// metric would have no real data behind it. If that's added later
// (e.g. a parentPortal.js endpoint for marking homework done), this route
// can be extended with a completionRate field per sub-strand at that point.
//
// Analytics angle, as designed for [[elimu]]: per sub-strand first, rolling
// up to per-subject once sub-strand data exists for most of a subject's
// strands - see bySubject's "coverage" field below for how that's surfaced.

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth, requireOwnClass } = require('../middleware/auth');

const router = express.Router();
const db = () => admin.firestore();

// GET /api/analytics/class/:classId?term=Term%202
// teacher: own class only. admin: any class.
router.get('/class/:classId', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { classId } = req.params;
    let query = db()
      .collection('schools').doc(req.schoolId)
      .collection('homework')
      .where('classId', '==', classId);

    // Homework doesn't store `term` directly (it inherits subStrand/subject
    // from its lesson plan, not term) - if a term filter is given, resolve
    // it via the linked lesson plans first.
    let homeworkDocs;
    if (req.query.term) {
      const lpSnap = await db()
        .collection('schools').doc(req.schoolId)
        .collection('lessonPlans')
        .where('classId', '==', classId)
        .where('term', '==', req.query.term)
        .get();
      const lpIds = new Set(lpSnap.docs.map((d) => d.id));

      const allHwSnap = await query.get();
      homeworkDocs = allHwSnap.docs.filter((d) => lpIds.has(d.data().lessonPlanId));
    } else {
      const snap = await query.get();
      homeworkDocs = snap.docs;
    }

    // Aggregate by sub-strand first.
    const bySubStrand = {};
    homeworkDocs.forEach((doc) => {
      const hw = doc.data();
      const key = hw.subStrand || '(no sub-strand)';
      if (!bySubStrand[key]) {
        bySubStrand[key] = { subject: hw.subject || '', subStrand: key, homeworkCount: 0, publishedCount: 0 };
      }
      bySubStrand[key].homeworkCount += 1;
      if (hw.status === 'published') bySubStrand[key].publishedCount += 1;
    });

    // Roll up to per-subject. `coverage` is how many distinct sub-strands
    // under that subject have at least one homework item - a rough signal
    // for whether the per-subject number is meaningful yet (a subject with
    // 1 of 6 sub-strands covered shouldn't be read the same as 5 of 6).
    const bySubject = {};
    Object.values(bySubStrand).forEach((row) => {
      const subj = row.subject || '(no subject)';
      if (!bySubject[subj]) {
        bySubject[subj] = { subject: subj, homeworkCount: 0, subStrandsCovered: 0 };
      }
      bySubject[subj].homeworkCount += row.homeworkCount;
      bySubject[subj].subStrandsCovered += 1;
    });

    res.json({
      classId,
      term: req.query.term || null,
      bySubStrand: Object.values(bySubStrand),
      bySubject: Object.values(bySubject),
    });
  } catch (err) {
    console.error('Class analytics failed:', err.message);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

module.exports = router;

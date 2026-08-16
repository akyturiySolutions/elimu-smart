// backend/routes/attendance.js
// Attendance tracking per class meeting.
// Firestore path: schools/{schoolId}/classes/{classId}/attendance/{date}
// Each attendance doc is keyed by date (YYYY-MM-DD) and holds a map of
// parentId -> present (boolean), so re-saving the same date overwrites cleanly.

const express = require('express');
const admin = require('firebase-admin');
const { requireAuth, blockReadOnlyRoles, requireOwnClass } = require('../middleware/auth');

const router = express.Router();
const db = () => admin.firestore();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/attendance/class/:classId
// body: { date?: "YYYY-MM-DD", records: [{ parentId, present }] }
router.post('/class/:classId', requireAuth, blockReadOnlyRoles, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { schoolId } = req;
    const { classId } = req.params;
    const { date, records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required' });
    }

    const attendanceDate = date || todayISO();
    const presentMap = {};
    records.forEach((r) => {
      if (r.parentId) presentMap[r.parentId] = !!r.present;
    });

    const presentCount = Object.values(presentMap).filter(Boolean).length;

    const docRef = db()
      .collection('schools').doc(schoolId)
      .collection('classes').doc(classId)
      .collection('attendance').doc(attendanceDate);

    await docRef.set({
      date: attendanceDate,
      records: presentMap,
      totalMembers: records.length,
      presentCount,
      recordedBy: req.user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ date: attendanceDate, presentCount, totalMembers: records.length });
  } catch (err) {
    console.error('Save attendance failed:', err.message);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

// GET /api/attendance/class/:classId?date=YYYY-MM-DD  - single date's attendance
router.get('/class/:classId', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { classId } = req.params;
    const date = req.query.date || todayISO();

    const doc = await db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(classId)
      .collection('attendance').doc(date).get();

    if (!doc.exists) {
      return res.json({ date, records: {}, presentCount: 0, totalMembers: 0 });
    }
    res.json(doc.data());
  } catch (err) {
    console.error('Get attendance failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// GET /api/attendance/class/:classId/history?limit=12  - recent meeting summaries
router.get('/class/:classId/history', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { classId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 12;

    const snap = await db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(classId)
      .collection('attendance')
      .orderBy('date', 'desc')
      .limit(limit)
      .get();

    const history = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        date: d.date,
        presentCount: d.presentCount,
        totalMembers: d.totalMembers,
      };
    });

    res.json({ history });
  } catch (err) {
    console.error('Attendance history failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance history' });
  }
});

// GET /api/attendance/class/:classId/parent/:parentId  - one parent's attendance rate
router.get('/class/:classId/parent/:parentId', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { classId, parentId } = req.params;

    const snap = await db()
      .collection('schools').doc(req.schoolId)
      .collection('classes').doc(classId)
      .collection('attendance')
      .orderBy('date', 'desc')
      .limit(52) // roughly a year of weekly meetings
      .get();

    let attended = 0;
    let total = 0;
    const dates = [];

    snap.docs.forEach((doc) => {
      const d = doc.data();
      if (Object.prototype.hasOwnProperty.call(d.records || {}, parentId)) {
        total += 1;
        const present = d.records[parentId];
        if (present) attended += 1;
        dates.push({ date: d.date, present });
      }
    });

    res.json({
      parentId,
      attended,
      total,
      rate: total > 0 ? Math.round((attended / total) * 100) : null,
      dates,
    });
  } catch (err) {
    console.error('Parent attendance failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch parent attendance' });
  }
});

// GET /api/attendance/class/:classId/rates?limit=12&threshold=50
// All parents' attendance rates for a class in ONE call (avoids N+1 requests
// from the frontend). Flags lowAttendance=true if rate < threshold AND
// there's enough data to judge fairly (at least 2 recorded meetings).
router.get('/class/:classId/rates', requireAuth, requireOwnClass((req) => req.params.classId), async (req, res) => {
  try {
    const { schoolId } = req;
    const { classId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 12;
    const threshold = parseInt(req.query.threshold, 10) || 50;

    const [attendanceSnap, parentsSnap] = await Promise.all([
      db().collection('schools').doc(schoolId).collection('classes').doc(classId)
        .collection('attendance').orderBy('date', 'desc').limit(limit).get(),
      db().collection('schools').doc(schoolId).collection('parents')
        .where('classId', '==', classId).get(),
    ]);

    const attendanceDocs = attendanceSnap.docs.map((d) => d.data());

    const rates = parentsSnap.docs.map((doc) => {
      const parent = doc.data();
      let attended = 0;
      let total = 0;

      attendanceDocs.forEach((d) => {
        if (Object.prototype.hasOwnProperty.call(d.records || {}, doc.id)) {
          total += 1;
          if (d.records[doc.id]) attended += 1;
        }
      });

      const rate = total > 0 ? Math.round((attended / total) * 100) : null;

      return {
        parentId: doc.id,
        name: parent.name,
        phone: parent.phone,
        whatsappNumber: parent.whatsappNumber || parent.phone,
        attended,
        total,
        rate,
        lowAttendance: rate !== null && total >= 2 && rate < threshold,
      };
    });

    // Lowest attendance first, so teachers see who needs a check-in first
    rates.sort((a, b) => (a.rate ?? 100) - (b.rate ?? 100));

    res.json({ rates, meetingsConsidered: attendanceDocs.length });
  } catch (err) {
    console.error('Attendance rates failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance rates' });
  }
});

module.exports = router;

// backend/server.js
// Standalone entry point. If you're folding this into your consolidated
// Express app (alongside GO OS / SupplyFlow / DalaDala on one Render instance),
// skip this file and instead do the following in that app:
//
//   const elimuClasses       = require('./elimu-smart/backend/routes/classes');
//   const elimuParents       = require('./elimu-smart/backend/routes/parents');
//   const elimuBroadcast     = require('./elimu-smart/backend/routes/broadcast');
//   const elimuAttendance    = require('./elimu-smart/backend/routes/attendance');
//   const elimuParentPortal  = require('./elimu-smart/backend/routes/parentPortal');
//   const elimuTeacherSignup = require('./elimu-smart/backend/routes/teacherSignup');
//   const elimuSchoolSignup  = require('./elimu-smart/backend/routes/schoolSignup');
//   const elimuLessonPlans   = require('./elimu-smart/backend/routes/lessonPlans');
//   const elimuHomework      = require('./elimu-smart/backend/routes/homework');
//   const elimuAnalytics     = require('./elimu-smart/backend/routes/analytics');
//   app.use('/api/elimu/classes', elimuClasses);
//   app.use('/api/elimu/parents', elimuParents);
//   app.use('/api/elimu/broadcast', elimuBroadcast);
//   app.use('/api/elimu/attendance', elimuAttendance);
//   app.use('/api/elimu/portal', elimuParentPortal);
//   app.use('/api/elimu/teacher-signup', elimuTeacherSignup);
//   app.use('/api/elimu/school-signup', elimuSchoolSignup);
//   app.use('/api/elimu/lesson-plans', elimuLessonPlans);
//   app.use('/api/elimu/homework', elimuHomework);
//   app.use('/api/elimu/analytics', elimuAnalytics);
//
// (prefix routes with /elimu to avoid clashing with existing route names)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Firebase Admin init - reuse same pattern as GO OS / SupplyFlow.
// Expects FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars
// (or a service account JSON, gitignored as you already do elsewhere).
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});

const classesRoutes = require('./routes/classes');
const parentsRoutes = require('./routes/parents');
const broadcastRoutes = require('./routes/broadcast');
const attendanceRoutes = require('./routes/attendance');
const parentPortalRoutes = require('./routes/parentPortal');
const teacherSignupRoutes = require('./routes/teacherSignup');
const schoolSignupRoutes = require('./routes/schoolSignup');
const lessonPlansRoutes = require('./routes/lessonPlans');
const homeworkRoutes = require('./routes/homework');
const analyticsRoutes = require('./routes/analytics');

const app = express();
app.use(cors());
// Default express.json() body limit is 100kb - far too small for a
// base64-encoded phone photo (often several MB before encoding, and
// base64 adds ~33% on top of that). Raised to 15mb for the homework OCR
// endpoint's image uploads.
app.use(express.json({ limit: '15mb' }));

app.use('/api/classes', classesRoutes);
app.use('/api/parents', parentsRoutes);
app.use('/api/broadcast', broadcastRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/portal', parentPortalRoutes);
app.use('/api/teacher-signup', teacherSignupRoutes);
app.use('/api/school-signup', schoolSignupRoutes);
app.use('/api/lesson-plans', lessonPlansRoutes);
app.use('/api/homework', homeworkRoutes);
app.use('/api/analytics', analyticsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'elimu-smart' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Elimu Smart backend running on port ' + PORT));

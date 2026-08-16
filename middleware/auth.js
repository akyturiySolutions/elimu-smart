// backend/middleware/auth.js
// Verifies Firebase Auth ID token and attaches req.user + req.schoolId + req.role + req.classId.
//
// Roles (set as custom claims when the account is created):
//   admin   - full CRUD on everything in their school (default if no role claim present,
//             so existing accounts created before roles existed keep working unchanged)
//             Covers what CellConnect split into "secretary" + "pastor" roles, plus headteacher powers:
//             admin/registration, lesson-plan approval, curriculum overrides, parentLinks, etc.
//   teacher - read/write scoped to ONLY their own class (req.classId), everywhere else read-only-none

const admin = require('firebase-admin');

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    req.schoolId = decoded.schoolId; // custom claim, set at account creation
    req.role = decoded.role || 'admin'; // default preserves pre-existing accounts' behavior
    req.classId = decoded.classId || null; // only meaningful for role === 'teacher'

    if (!req.schoolId) {
      return res.status(403).json({ error: 'Account not linked to a school' });
    }

    next();
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Placeholder retained for parity with CellConnect's route wiring (routes may still
// import blockReadOnlyRoles). No role is read-only in Elimu Smart's two-role model,
// so this is a no-op passthrough — safe to remove once routes are cleaned up.
function blockReadOnlyRoles(req, res, next) {
  next();
}

// For routes scoped to a specific class (parents, homework, lesson plans, attendance).
// Teachers can only act on their own class; admin is unrestricted.
// `getClassId` extracts the target classId from the request (params, body, or query).
function requireOwnClass(getClassId) {
  return (req, res, next) => {
    if (req.role !== 'teacher') return next(); // admin unrestricted

    const targetClassId = getClassId(req);
    if (!targetClassId || targetClassId !== req.classId) {
      return res.status(403).json({ error: 'Teachers can only access their own class' });
    }
    next();
  };
}

module.exports = { requireAuth, blockReadOnlyRoles, requireOwnClass };

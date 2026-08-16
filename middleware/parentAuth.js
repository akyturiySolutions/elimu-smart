// backend/middleware/parentAuth.js
//
// STATUS: NOT CURRENTLY USED. Ported from CellConnect's memberAuth.js, where
// OTP verification was removed by product decision - the parent portal no
// longer requires it (see routes/parentPortal.js for the security tradeoff
// notes). Kept here in case OTP verification needs to be restored later -
// just re-add `requireParentAuth` to the portal routes and re-enable
// Firebase Phone Auth in frontend/js/portal.js.
//
// Verifies a Firebase phone-auth ID token (parent portal), as opposed to
// middleware/auth.js which verifies admin/teacher tokens with a schoolId claim.
//
// Parents sign in with just their phone number (Firebase Phone Auth + OTP),
// no password, no custom claim. We match them to a parent record by phone
// number, scoped to whichever school the portal URL is for.

const admin = require('firebase-admin');

async function requireParentAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    if (!decoded.phone_number) {
      return res.status(403).json({ error: 'Account has no verified phone number' });
    }

    // decoded.phone_number is E.164, e.g. +254722914407 - normalize to
    // match how phone/whatsappNumber are stored (254722914407, no +).
    req.parentPhone = decoded.phone_number.replace(/\D/g, '');
    next();
  } catch (err) {
    console.error('Parent auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireParentAuth };

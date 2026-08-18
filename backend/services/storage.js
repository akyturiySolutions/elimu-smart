// backend/services/storage.js
// Uploads homework photos to Firebase Storage instead of embedding them as
// base64 inside the Firestore homework document.
//
// Why this exists (context for future-you): Firestore has a hard 1MB
// per-document limit, and base64 inflates file size by ~33% over the raw
// binary - a normal phone photo (2-8MB) would already blow past that limit
// on write. Storage has no such limit, is meaningfully cheaper per GB than
// Firestore, and means listing homework doesn't drag full images along
// with it on every read.

const admin = require('firebase-admin');
const crypto = require('crypto');

const EXTENSION_BY_MEDIA_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

// Uploads a base64-encoded image and returns a long-lived download URL.
// Path shape: schools/{schoolId}/homework-images/{randomId}.{ext}
async function uploadHomeworkImage(schoolId, imageBase64, mediaType) {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not configured on the server');
  }

  const ext = EXTENSION_BY_MEDIA_TYPE[mediaType] || 'jpg';
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const filePath = `schools/${schoolId}/homework-images/${fileName}`;

  const buffer = Buffer.from(imageBase64, 'base64');
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);

  await file.save(buffer, {
    metadata: { contentType: mediaType },
  });

  // Signed URL far in the future - functionally permanent for this app's
  // purposes (homework photos aren't meant to expire). Simpler than wiring
  // up Firebase's client-SDK download-token pattern for a backend-only use case.
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '01-01-2100',
  });

  return { url, storagePath: filePath };
}

module.exports = { uploadHomeworkImage };

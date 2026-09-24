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
//
// 2026-09: added uploadHomeworkPdf/deleteHomeworkFile for the photo->PDF
// homework redesign (AI OCR removed). uploadHomeworkPdf follows the exact
// same pattern as uploadHomeworkImage below - same bucket, same
// far-future signed URL, same schools/{schoolId}/... path shape - just a
// sibling "homework-pdfs" folder instead of "homework-images", since a PDF
// isn't a media type in EXTENSION_BY_MEDIA_TYPE.

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

// Uploads the generated homework PDF (a Buffer, not base64 - it comes
// straight out of pdf-lib) and returns a long-lived download URL, same
// shape as uploadHomeworkImage above.
// Path shape: schools/{schoolId}/homework-pdfs/{randomId}.pdf
async function uploadHomeworkPdf(schoolId, pdfBuffer) {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not configured on the server');
  }

  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  const filePath = `schools/${schoolId}/homework-pdfs/${fileName}`;

  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);

  await file.save(pdfBuffer, {
    metadata: { contentType: 'application/pdf' },
  });

  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '01-01-2100',
  });

  return { url, storagePath: filePath };
}

// Deletes a file (photo or PDF) by its storagePath, e.g. when a draft is
// edited (old PDF replaced) or deleted. Best-effort cleanup - never
// something a request should fail over, so a missing file is not an error.
async function deleteHomeworkFile(storagePath) {
  if (!storagePath) return;
  try {
    await admin.storage().bucket().file(storagePath).delete();
  } catch (err) {
    if (err.code === 404) return; // already gone - fine
    throw err;
  }
}

module.exports = { uploadHomeworkImage, uploadHomeworkPdf, deleteHomeworkFile };
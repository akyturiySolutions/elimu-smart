// homework.js
//
// 2026-09 redesign: the AI OCR/structuring flow (Gemini transcribe + Gemini
// structure) has been REMOVED. It added a second reading a teacher had to
// verify (fix [unclear] markers, then re-check the auto-filled fields), and
// added AI cost/latency to a simple job. New flow: the teacher photographs
// the homework note (or types instructions directly, or both), and the
// backend turns that straight into a single-page PDF via pdfHomework.js.
// That PDF is what gets forwarded to parents (click-to-chat link, same
// pattern as everywhere else in this app - see below) and it's what gets
// printed.
//
// ocrGemini.js and aiStructureGemini.js are left in place but unused, same
// as ocrClaude.js already was - nothing calls them from this file anymore.
// middleware/rateLimiter.js (built for the /ocr and /structure routes) is
// likewise unused by this file now; it's not wired into any homework route
// below. Leave it in the repo in case another AI feature needs it later -
// see docs/RUNBOOK.md's "intentionally dormant code" section, which should
// be updated to add /ocr, /structure, ocrGemini.js and aiStructureGemini.js
// to the dormant list.
//
// Publishing does NOT send WhatsApp messages from the backend (no WABA -
// see /areas project notes: click-to-chat only, by explicit choice). This
// route just flips status to "published" and returns the updated record;
// the frontend builds one wa.me link per parent client-side, from the
// parents it already has cached, the same way Attendance and the
// low-attendance check-in do.

const express = require("express");
const admin = require("firebase-admin");
const router = express.Router();

const { requireAuth, blockReadOnlyRoles } = require("../middleware/auth");
const { buildHomeworkPdf } = require("../services/pdfHomework");
const { uploadHomeworkImage, uploadHomeworkPdf, deleteHomeworkFile } = require("../services/storage");

const db = () => admin.firestore();

function homeworkCollection(schoolId) {
  return db().collection("schools").doc(schoolId).collection("homework");
}

function linesFromArray(materials) {
  return Array.isArray(materials) ? materials.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()) : [];
}

// ---------- GET / - list this teacher's (or, for admin, the school's) homework ----------
router.get("/", requireAuth, async (req, res) => {
  try {
    let query = homeworkCollection(req.schoolId);
    if (req.role === "teacher") {
      query = query.where("teacherId", "==", req.user.uid);
    } else {
      if (req.query.classId) query = query.where("classId", "==", req.query.classId);
      if (req.query.status) query = query.where("status", "==", req.query.status);
    }
    // No orderBy here on purpose: where(teacherId) + orderBy(updatedAt)
    // would need a composite Firestore index.
    const snap = await query.get();
    const homework = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ homework });
  } catch (err) {
    console.error("GET /homework failed:", err);
    res.status(500).json({ error: "Couldn't load homework." });
  }
});

// ---------- GET /:id ----------
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const doc = await homeworkCollection(req.schoolId).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Homework not found." });
    if (req.role === "teacher" && doc.data().teacherId !== req.user.uid) {
      return res.status(403).json({ error: "Teachers can only access their own homework." });
    }
    res.json({ homework: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("GET /homework/:id failed:", err);
    res.status(500).json({ error: "Couldn't load homework." });
  }
});

// ---------- POST / - create a draft ----------
// Body: { classId, lessonPlanId, subject, instructions, dueDate, materials,
//         photoBase64, photoMediaType }
// At least one of `instructions` (non-empty text) or `photoBase64` is
// required - the PDF needs something to put on the page.
router.post("/", requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== "teacher") {
      return res.status(403).json({ error: "Only teachers manage homework." });
    }
    const { classId, lessonPlanId, subject, instructions, dueDate, materials, photoBase64, photoMediaType } = req.body;

    if (!classId || !lessonPlanId) {
      return res.status(400).json({ error: "classId and lessonPlanId are required." });
    }
    const hasInstructions = typeof instructions === "string" && instructions.trim().length > 0;
    const hasPhoto = typeof photoBase64 === "string" && photoBase64.length > 0;
    if (!hasInstructions && !hasPhoto) {
      return res.status(400).json({ error: "Add a photo of the homework note, or type instructions, before saving." });
    }

    if (classId !== req.classId) {
      return res.status(403).json({ error: "Teachers can only create homework for their own class." });
    }

    const lessonPlanDoc = await db().collection("schools").doc(req.schoolId).collection("lessonPlans").doc(lessonPlanId).get();
    if (!lessonPlanDoc.exists) {
      return res.status(400).json({ error: "That lesson plan doesn't exist." });
    }
    const lessonPlan = lessonPlanDoc.data();
    if (lessonPlan.status !== "approved") {
      return res.status(400).json({ error: "Homework must be linked to an approved lesson plan." });
    }
    if (req.role === "teacher" && lessonPlan.teacherId !== req.user.uid) {
      return res.status(403).json({ error: "That lesson plan isn't yours." });
    }

    const materialsList = linesFromArray(materials);
    const resolvedSubject = (subject && subject.trim()) || lessonPlan.subject || "Homework";

    let imageBuffer = null;
    let mediaType = null;
    let photoStoragePath = null;
    if (hasPhoto) {
      imageBuffer = Buffer.from(photoBase64, "base64");
      mediaType = photoMediaType || "image/jpeg";
      // Keep the photo itself too, so later edits can rebuild the PDF with it.
      const uploadedPhoto = await uploadHomeworkImage(req.schoolId, photoBase64, mediaType);
      photoStoragePath = uploadedPhoto.storagePath;
    }

    // Look up the class name for the PDF header - falls back gracefully if
    // the classes collection lookup fails for any reason.
    let className = "";
    try {
      const classDoc = await db().collection("schools").doc(req.schoolId).collection("classes").doc(classId).get();
      if (classDoc.exists) className = classDoc.data().name || "";
    } catch (_) {
      // non-fatal - PDF just omits the class name
    }

    const pdfBuffer = await buildHomeworkPdf({
      subject: resolvedSubject,
      className,
      dueDate: dueDate || "",
      instructions: instructions || "",
      materials: materialsList,
      imageBuffer,
      imageMediaType: mediaType,
    });

    const { url: pdfUrl, storagePath: pdfStoragePath } = await uploadHomeworkPdf(req.schoolId, pdfBuffer);

    const now = admin.firestore.FieldValue.serverTimestamp();
    const docData = {
      classId,
      lessonPlanId,
      teacherId: req.user.uid,
      subject: resolvedSubject,
      subStrand: lessonPlan.subStrand || null,
      instructions: instructions || "",
      dueDate: dueDate || null,
      materials: materialsList,
      sourceType: hasPhoto ? "photo" : "manual",
      photoStoragePath,
      photoMediaType: hasPhoto ? mediaType : null,
      pdfUrl,
      pdfStoragePath,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    const ref = await homeworkCollection(req.schoolId).add(docData);
    const saved = await ref.get();
    res.status(201).json({ homework: { id: saved.id, ...saved.data() } });
  } catch (err) {
    console.error("POST /homework failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save homework." });
  }
});

// ---------- PUT /:id - edit while still a draft ----------
router.put("/:id", requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== "teacher") {
      return res.status(403).json({ error: "Only teachers manage homework." });
    }
    const ref = homeworkCollection(req.schoolId).doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "Homework not found." });
    const current = existing.data();

    if (current.status !== "draft") {
      return res.status(400).json({ error: "Only draft homework can be edited." });
    }
    if (req.role === "teacher" && current.teacherId !== req.user.uid) {
      return res.status(403).json({ error: "That's not your homework." });
    }

    const { subject, instructions, dueDate, materials, photoBase64, photoMediaType } = req.body;
    const hasInstructions = typeof instructions === "string" && instructions.trim().length > 0;
    const hasNewPhoto = typeof photoBase64 === "string" && photoBase64.length > 0;
    const materialsList = linesFromArray(materials);
    const resolvedSubject = (subject && subject.trim()) || current.subject;

    let className = "";
    try {
      const classDoc = await db().collection("schools").doc(req.schoolId).collection("classes").doc(current.classId).get();
      if (classDoc.exists) className = classDoc.data().name || "";
    } catch (_) {
      // non-fatal
    }

    // Work out which photo goes into the rebuilt PDF: a newly attached one,
    // or the one this draft already has in Storage (photoStoragePath, or
    // originalImageStoragePath on drafts saved by the pre-PDF backend).
    let imageBuffer = null;
    let mediaType = null;
    let photoStoragePath = current.photoStoragePath || current.originalImageStoragePath || null;
    let photoMediaTypeStored = current.photoMediaType || "image/jpeg";

    if (hasNewPhoto) {
      mediaType = photoMediaType || "image/jpeg";
      imageBuffer = Buffer.from(photoBase64, "base64");
      const uploadedPhoto = await uploadHomeworkImage(req.schoolId, photoBase64, mediaType);
      if (photoStoragePath && photoStoragePath !== uploadedPhoto.storagePath) {
        deleteHomeworkFile(photoStoragePath).catch((e) => console.error("Couldn't delete old homework photo:", e.message));
      }
      photoStoragePath = uploadedPhoto.storagePath;
      photoMediaTypeStored = mediaType;
    } else if (photoStoragePath) {
      try {
        const [bytes] = await admin.storage().bucket().file(photoStoragePath).download();
        imageBuffer = bytes;
        mediaType = photoMediaTypeStored;
      } catch (e) {
        console.error("Couldn't load existing homework photo (PDF will be text-only):", e.message);
        photoStoragePath = null;
      }
    }

    if (!hasInstructions && !imageBuffer) {
      return res.status(400).json({ error: "Add a photo of the homework note, or type instructions, before saving." });
    }

    // Always rebuild the PDF on edit, so text changes show up in it too.
    const pdfBuffer = await buildHomeworkPdf({
      subject: resolvedSubject,
      className,
      dueDate: dueDate || "",
      instructions: instructions || "",
      materials: materialsList,
      imageBuffer,
      imageMediaType: mediaType,
    });
    const uploaded = await uploadHomeworkPdf(req.schoolId, pdfBuffer);
    const pdfUrl = uploaded.url;
    const pdfStoragePath = uploaded.storagePath;
    if (current.pdfStoragePath && current.pdfStoragePath !== pdfStoragePath) {
      deleteHomeworkFile(current.pdfStoragePath).catch((e) => console.error("Couldn't delete old homework PDF:", e.message));
    }

    await ref.update({
      subject: resolvedSubject,
      instructions: instructions || "",
      dueDate: dueDate || null,
      materials: materialsList,
      sourceType: imageBuffer ? "photo" : "manual",
      photoStoragePath,
      photoMediaType: imageBuffer ? photoMediaTypeStored : null,
      pdfUrl,
      pdfStoragePath,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const updated = await ref.get();
    res.json({ homework: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error("PUT /homework/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update homework." });
  }
});

// ---------- POST /:id/publish ----------
// No WhatsApp send happens here - see the file-header note. This just marks
// the record published so the frontend knows to render Send links.
router.post("/:id/publish", requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== "teacher") {
      return res.status(403).json({ error: "Only teachers manage homework." });
    }
    const ref = homeworkCollection(req.schoolId).doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "Homework not found." });
    const current = existing.data();

    if (req.role === "teacher" && current.teacherId !== req.user.uid) {
      return res.status(403).json({ error: "That's not your homework." });
    }
    if (current.status === "published") {
      return res.status(400).json({ error: "Already published." });
    }

    await ref.update({ status: "published", publishedAt: admin.firestore.FieldValue.serverTimestamp() });
    const updated = await ref.get();
    res.json({ homework: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error("POST /homework/:id/publish failed:", err);
    res.status(500).json({ error: err.message || "Couldn't publish homework." });
  }
});

// ---------- DELETE /:id - draft only ----------
router.delete("/:id", requireAuth, blockReadOnlyRoles, async (req, res) => {
  try {
    if (req.role !== "teacher") {
      return res.status(403).json({ error: "Only teachers manage homework." });
    }
    const ref = homeworkCollection(req.schoolId).doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "Homework not found." });
    const current = existing.data();

    if (current.status !== "draft") {
      return res.status(400).json({ error: "Only draft homework can be deleted." });
    }
    if (req.role === "teacher" && current.teacherId !== req.user.uid) {
      return res.status(403).json({ error: "That's not your homework." });
    }

    await ref.delete();
    [current.pdfStoragePath, current.photoStoragePath, current.originalImageStoragePath]
      .filter(Boolean)
      .forEach((path) => deleteHomeworkFile(path).catch((e) => console.error("Couldn't delete homework file:", e.message)));
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /homework/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete homework." });
  }
});

module.exports = router;
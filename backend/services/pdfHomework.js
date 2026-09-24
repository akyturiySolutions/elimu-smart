// pdfHomework.js
//
// Builds a single-page A4 PDF for a homework item: a header (subject, class,
// due date), optional typed instructions/materials, and — when the teacher
// attached a photo of a handwritten note — the photo itself embedded on the
// page. This replaced the AI OCR/structuring flow (2026-09): instead of
// transcribing the photo into text with Gemini, we just turn it straight
// into a printable, forwardable PDF. No AI call, no per-teacher rate limit
// needed for this route.
//
// Uses pdf-lib (pure JS, no native/binary dependency) - add it to
// backend/package.json:
//   npm install pdf-lib
//
// This keeps the app's "no server-side PDF library until now" pattern
// broken in the smallest possible way: one small, dependency-light library,
// used only here.

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const PAGE_WIDTH = 595.28; // A4 at 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Greedy word-wrap using the font's actual character widths.
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  (text || "").split(/\r?\n/).forEach((paragraph) => {
    if (!paragraph.trim()) {
      lines.push("");
      return;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);
  });
  return lines;
}

/**
 * @param {Object} opts
 * @param {string} opts.subject
 * @param {string} opts.className
 * @param {string} opts.dueDate
 * @param {string} opts.instructions
 * @param {string[]} opts.materials
 * @param {Buffer} [opts.imageBuffer] - the homework photo, if one was attached
 * @param {string} [opts.imageMediaType] - e.g. "image/jpeg" or "image/png"
 * @returns {Promise<Buffer>} the finished single-file PDF
 */
async function buildHomeworkPdf({ subject, className, dueDate, instructions, materials, imageBuffer, imageMediaType }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function newPageIfNeeded(neededHeight) {
    if (y - neededHeight < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  }

  function drawLine(text, { size = 11, bold = false, color = rgb(0, 0, 0), gap = 15 } = {}) {
    newPageIfNeeded(gap);
    page.drawText(text, { x: MARGIN, y, size, font: bold ? fontBold : font, color });
    y -= gap;
  }

  function drawWrapped(text, { size = 11, bold = false, color = rgb(0, 0, 0), gap = 14 } = {}) {
    const chosenFont = bold ? fontBold : font;
    wrapText(text, chosenFont, size, CONTENT_WIDTH).forEach((line) => {
      newPageIfNeeded(gap);
      page.drawText(line, { x: MARGIN, y, size, font: chosenFont, color });
      y -= gap;
    });
  }

  // Header
  drawLine(subject || "Homework", { size: 18, bold: true, gap: 24 });
  const metaBits = [className, dueDate ? `Due ${dueDate}` : null].filter(Boolean).join("   ·   ");
  if (metaBits) drawLine(metaBits, { size: 11, color: rgb(0.35, 0.35, 0.35), gap: 20 });
  y -= 6;

  if (instructions && instructions.trim()) {
    drawLine("Instructions", { size: 12, bold: true, gap: 16 });
    drawWrapped(instructions.trim(), { size: 11, gap: 14 });
    y -= 10;
  }

  if (materials && materials.length) {
    drawLine("Materials Needed", { size: 12, bold: true, gap: 16 });
    materials.forEach((m) => drawWrapped(`• ${m}`, { size: 11, gap: 14 }));
    y -= 10;
  }

  if (imageBuffer) {
    let embedded;
    try {
      // pdf-lib reads the raw ArrayBuffer off the typed array it's given,
      // ignoring byteOffset - a Node Buffer can be a view into a larger
      // pooled ArrayBuffer, which corrupts the read. Copy into a clean,
      // zero-offset Uint8Array first.
      const cleanBytes = new Uint8Array(imageBuffer);
      embedded = imageMediaType && imageMediaType.includes("png")
        ? await pdfDoc.embedPng(cleanBytes)
        : await pdfDoc.embedJpg(cleanBytes);
    } catch (err) {
      throw new Error("Couldn't read that photo - please try a JPEG or PNG.");
    }

    const remainingHeight = y - MARGIN;
    // If less than ~150pt is left on this page, start the image on a fresh
    // page instead of squeezing it into a sliver.
    if (remainingHeight < 150) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    const maxWidth = CONTENT_WIDTH;
    const maxHeight = y - MARGIN;
    const natural = embedded.scale(1);
    const scale = Math.min(maxWidth / natural.width, maxHeight / natural.height, 1);
    const width = natural.width * scale;
    const height = natural.height * scale;

    page.drawImage(embedded, { x: MARGIN, y: y - height, width, height });
    y -= height + 10;
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { buildHomeworkPdf };

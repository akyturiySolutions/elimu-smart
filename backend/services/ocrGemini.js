// backend/services/ocrGemini.js
// Uses Gemini (vision) to transcribe a photo of a handwritten homework note
// - a Gemini-only alternative to services/ocrClaude.js, so the whole
// AI/OCR pipeline can run on Gemini's free tier without any Anthropic
// billing commitment. Same {text, confidence} contract as ocrClaude.js, so
// routes/homework.js only needs to swap which service it imports - no
// other route logic changes.
//
// Trade-off worth knowing (see [[elimu]] notes): this is a smaller/cheaper
// model than Claude Sonnet for vision tasks, so handwriting transcription
// accuracy may be somewhat lower, especially on messy handwriting or
// unusual layouts. Good enough to validate the full pipeline end-to-end
// before deciding whether Claude's better accuracy is worth paying for.
//
// Confidence-based routing, same design as ocrClaude.js:
//   - high/medium confidence -> return the text with [unclear] markers inline
//   - low confidence (mostly illegible) -> caller treats this as a hard
//     error and asks the teacher to retake the photo.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// NOTE: Google deprecates Gemini model versions periodically - if this
// starts failing with "model no longer available", the error message
// itself names the current replacement model to switch to.
const MODEL = 'gemini-3.6-flash';

const PROMPT = `You transcribe photos of handwritten homework notes written by teachers for a school app.
Transcribe the text as literally as possible - do not summarize, correct spelling, or restructure it.
Where a word or short phrase is illegible or you are genuinely unsure, replace ONLY that word/phrase with [unclear] - never guess.
If the note includes a diagram, shape, or drawing (e.g. a triangle, number line, table), briefly describe it in words in brackets, e.g. [diagram: right-angled triangle, right angle at bottom-left, angle x at top vertex, angle 40 degrees at bottom-right vertex].
Respond with ONLY a JSON object, no markdown fences, no preamble:
{"text": "<the transcription, with [unclear] markers and any [diagram: ...] descriptions inline>", "confidence": "high" | "medium" | "low"}
Use "low" confidence if most of the note is illegible or the image doesn't appear to contain readable handwriting at all.`;

async function transcribeHomeworkImage(imageBase64, mediaType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mediaType, data: imageBase64 } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini OCR request failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();

  let parsed;
  try {
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Could not parse OCR response');
  }

  const text = parsed.text || '';
  let confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';

  // Same backstop heuristic as ocrClaude.js - don't trust an overconfident
  // self-report if a large fraction of the text is [unclear] markers.
  const unclearCount = (text.match(/\[unclear\]/g) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length || 1;
  if (unclearCount / wordCount > 0.4) {
    confidence = 'low';
  }

  return { text, confidence };
}

module.exports = { transcribeHomeworkImage };

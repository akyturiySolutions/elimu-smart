// backend/services/ocrClaude.js
// Uses Claude (vision) to transcribe a photo of a handwritten homework note.
//
// Confidence-based routing, as designed for [[elimu]]:
//   - high/medium confidence -> return the text with [unclear] markers inline
//     wherever the model wasn't sure of a word, so the teacher can fill gaps
//     in the review screen rather than starting over.
//   - low confidence (mostly illegible) -> caller should treat this as a
//     hard error and ask the teacher to retake the photo, rather than show
//     a garbled structured form that's worse than starting fresh.
//
// Claude doesn't expose a calibrated confidence score directly, so we ask it
// to self-report one alongside the transcription and treat that as advisory -
// combined with a simple heuristic (density of [unclear] markers) as a
// backstop in case the model is overconfident.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `You transcribe photos of handwritten homework notes written by teachers for a school app.
Transcribe the text as literally as possible - do not summarize, correct spelling, or restructure it.
Where a word or short phrase is illegible or you are genuinely unsure, replace ONLY that word/phrase with [unclear] - never guess.
Respond with ONLY a JSON object, no markdown fences, no preamble:
{"text": "<the transcription, with [unclear] markers inline where needed>", "confidence": "high" | "medium" | "low"}
Use "low" confidence if most of the note is illegible or the image doesn't appear to contain readable handwriting at all.`;

// imageBase64: raw base64 (no data: prefix). mediaType: e.g. "image/jpeg", "image/png".
async function transcribeHomeworkImage(imageBase64, mediaType) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Transcribe this handwritten homework note.' },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Claude OCR request failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText = (data.content || []).map((block) => block.text || '').join('').trim();

  let parsed;
  try {
    // Strip accidental markdown fences if the model adds them despite instructions.
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Could not parse OCR response');
  }

  const text = parsed.text || '';
  let confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';

  // Backstop heuristic: if a large fraction of the text is [unclear] markers,
  // don't trust a "high"/"medium" self-report - downgrade to low so the
  // caller routes to "retake photo" instead of a mostly-blank review form.
  const unclearCount = (text.match(/\[unclear\]/g) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length || 1;
  if (unclearCount / wordCount > 0.4) {
    confidence = 'low';
  }

  return { text, confidence };
}

module.exports = { transcribeHomeworkImage };

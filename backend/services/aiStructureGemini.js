// backend/services/aiStructureGemini.js
// Uses Gemini 2.0 Flash to turn raw (possibly messy) OCR text into structured
// homework fields the teacher can review/edit before publishing - the
// "Gemini 2.0 Flash for other AI tasks" half of [[elimu]]'s AI/OCR flow.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.0-flash';

const PROMPT_INSTRUCTIONS = `You turn a raw, possibly messy transcription of a teacher's handwritten homework note into structured fields for a school app.
The text may contain [unclear] markers where the original handwriting couldn't be read - leave those as-is, don't guess what they say.
Respond with ONLY a JSON object, no markdown fences, no preamble:
{
  "subject": "<best guess at the subject, or empty string if not mentioned>",
  "instructions": "<the homework instructions, cleaned up into clear sentences but keeping all original content and any [unclear] markers>",
  "dueDate": "<a date if one is mentioned in the text, in YYYY-MM-DD format if you can determine the year from context, otherwise empty string>",
  "materials": ["<list of materials/items needed, if any are mentioned>"]
}`;

async function structureHomeworkText(rawText) {
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
          parts: [{ text: `${PROMPT_INSTRUCTIONS}\n\nRaw text:\n${rawText}` }],
        },
      ],
      generationConfig: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini structuring request failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawOut = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();

  let parsed;
  try {
    const cleaned = rawOut.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Could not parse structuring response');
  }

  return {
    subject: parsed.subject || '',
    instructions: parsed.instructions || '',
    dueDate: parsed.dueDate || '',
    materials: Array.isArray(parsed.materials) ? parsed.materials : [],
  };
}

module.exports = { structureHomeworkText };

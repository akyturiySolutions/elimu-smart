// backend/services/whatsapp.js
// Thin wrapper around WhatsApp Cloud API for 1:1 sends.
//
// Each school has its OWN dedicated WhatsApp number (its own Phone Number ID),
// but all numbers live under the same Meta Business Manager / WABA, so they
// share one access token and one approved message template.
//
// phoneNumberId is passed in per-call (read from the school's Firestore doc
// by the caller) rather than fixed in .env, since it's no longer global.
//
// IMPORTANT: WhatsApp only allows free-form text messages to a user within
// a 24-hour window after that user last messaged your number. Outside that
// window (the normal case for a "send reminder" broadcast), you MUST use a
// pre-approved message template - e.g. "cellconnect_announcement" with a
// single {{1}} body variable.

const GRAPH_VERSION = 'v21.0';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'cellconnect_announcement';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';

function normalizePhone(phone) {
  // Expects Kenyan numbers like 07XXXXXXXX or already-international 2547XXXXXXXX
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) return '254' + digits.slice(1);
  if (digits.startsWith('254')) return digits;
  return digits;
}

async function sendTemplateMessage(phoneNumberId, toPhone, bodyText) {
  if (!phoneNumberId) {
    return { to: toPhone, success: false, error: 'This school has no WhatsApp number configured yet' };
  }

  const to = normalizePhone(toPhone);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: bodyText }],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    return { to, success: false, error: data.error?.message || 'Send failed' };
  }
  return { to, success: true, messageId: data.messages?.[0]?.id };
}

// Use for replies within an open 24h session (e.g. parent texted the bot recently).
async function sendSessionText(phoneNumberId, toPhone, bodyText) {
  if (!phoneNumberId) {
    return { to: toPhone, success: false, error: 'This school has no WhatsApp number configured yet' };
  }

  const to = normalizePhone(toPhone);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: bodyText },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    return { to, success: false, error: data.error?.message || 'Send failed' };
  }
  return { to, success: true, messageId: data.messages?.[0]?.id };
}

module.exports = { sendTemplateMessage, sendSessionText, normalizePhone };

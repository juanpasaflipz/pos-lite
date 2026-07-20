import { fetchWithTimeout } from '../lib/http.js';
// Twilio media → OpenAI Whisper transcription.
//
// Twilio voice notes from WhatsApp are typically audio/ogg (Opus codec).
// Whisper accepts ogg/opus directly, so no transcoding step is needed.
// Media URLs are protected by Twilio basic auth (account SID + auth token).

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';

function extensionFor(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  if (t.includes('wav')) return 'wav';
  if (t.includes('webm')) return 'webm';
  return 'ogg';
}

export async function fetchTwilioMedia(mediaUrl, { accountSid, authToken }) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetchWithTimeout(mediaUrl, { timeoutMs: 15000,
    headers: { Authorization: `Basic ${auth}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Twilio media fetch ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const contentType = res.headers.get('content-type') || 'audio/ogg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export async function transcribeAudio(buffer, contentType, { language = 'es' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const ext = extensionFor(contentType);
  const blob = new Blob([buffer], { type: contentType || 'audio/ogg' });
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', WHISPER_MODEL);
  if (language) form.append('language', language);
  form.append('response_format', 'json');

  const res = await fetchWithTimeout(WHISPER_URL, { timeoutMs: 30000,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  return String(data.text || '').trim();
}

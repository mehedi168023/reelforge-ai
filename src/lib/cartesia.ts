import type { Word } from './eleven';

// Cartesia is a cheaper text-to-speech and speech-to-text provider. It supports Bengali.
const BASE: string = import.meta.env.VITE_CARTESIA_BASE || 'https://api.cartesia.ai';
// The API version is required on every request. This is a fixed date string, not a model.
const VERSION = '2026-08-14';

async function reason(res: Response): Promise<string> {
  if (res.status === 401) return 'Cartesia rejected this API key.';
  if (res.status === 402 || res.status === 429) return 'Cartesia: no credits left, or too many requests.';
  if (res.status === 404) return "Cartesia can't find this voice ID on your account.";
  try {
    const data = (await res.json()) as { error?: { message?: string }; message?: string; detail?: string };
    const message = data?.error?.message ?? data?.message ?? (typeof data?.detail === 'string' ? data.detail : undefined);
    if (message) return `Cartesia: ${message}`;
  } catch {
    // the status below is all there is
  }
  return `Cartesia answered with status ${res.status}.`;
}

async function call(path: string, key: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION, ...init?.headers } });
  } catch {
    throw new Error("Can't reach Cartesia. Check your internet.");
  }
  if (!res.ok) throw new Error(await reason(res));
  return res;
}

/** Returns the voice's name without spending credits. */
export async function checkVoice(key: string, voiceId: string): Promise<string> {
  const res = await call(`/voices/${encodeURIComponent(voiceId)}`, key);
  return ((await res.json()) as { name?: string }).name ?? voiceId;
}

export async function speak(key: string, voiceId: string, model: string, text: string, language?: string): Promise<Blob> {
  const res = await call('/tts/bytes', key, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: model || 'sonic-3.6',
      transcript: text,
      voice: { id: voiceId },
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      ...(language ? { language } : {}),
    }),
  });
  return res.blob();
}

export async function transcribe(key: string, file: Blob, fileName: string, language?: string): Promise<Word[]> {
  const form = new FormData();
  form.set('model', 'ink-whisper');
  form.set('timestamp_granularities[]', 'word');
  if (language) form.set('language', language);
  form.set('file', file, fileName);
  const res = await call('/stt', key, { method: 'POST', body: form });
  const { words = [] } = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
  // Cartesia names the field "word"; the app uses "text" everywhere else.
  return words.map(({ word, start, end }) => ({ text: word, start, end }));
}

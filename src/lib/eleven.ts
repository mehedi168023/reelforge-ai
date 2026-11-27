const BASE: string = import.meta.env.VITE_ELEVEN_BASE || 'https://api.elevenlabs.io';

async function reason(res: Response): Promise<string> {
  if (res.status === 401) return 'ElevenLabs rejected this API key.';
  if (res.status === 402 || res.status === 429) return 'ElevenLabs: no credits left, or too many requests.';
  if (res.status === 404) return "ElevenLabs can't find this voice ID on your account.";
  try {
    const { detail } = (await res.json()) as { detail?: string | { message?: string } };
    if (typeof detail === 'string') return `ElevenLabs: ${detail}`;
    if (detail?.message) return `ElevenLabs: ${detail.message}`;
  } catch {
    // the status below is all there is
  }
  return `ElevenLabs answered with status ${res.status}.`;
}

async function call(path: string, key: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { 'xi-api-key': key, ...init?.headers } });
  } catch {
    throw new Error("Can't reach ElevenLabs. Check your internet.");
  }
  if (!res.ok) throw new Error(await reason(res));
  return res;
}

/** Returns the voice's name without spending credits. */
export async function checkVoice(key: string, voiceId: string): Promise<string> {
  const res = await call(`/v1/voices/${encodeURIComponent(voiceId)}`, key);
  return ((await res.json()) as { name?: string }).name ?? voiceId;
}

export async function speak(key: string, voiceId: string, model: string, text: string, language?: string): Promise<Blob> {
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, key, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, ...(language ? { language_code: language } : {}) }),
  });
  return res.blob();
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

export async function transcribe(key: string, file: Blob, fileName: string, language?: string): Promise<Word[]> {
  const form = new FormData();
  form.set('model_id', 'scribe_v2');
  form.set('timestamps_granularity', 'word');
  if (language) form.set('language_code', language);
  form.set('file', file, fileName);
  const res = await call('/v1/speech-to-text', key, { method: 'POST', body: form });
  const { words = [] } = (await res.json()) as { words?: (Word & { type: string })[] };
  return words.filter((w) => w.type === 'word').map(({ text, start, end }) => ({ text, start, end }));
}

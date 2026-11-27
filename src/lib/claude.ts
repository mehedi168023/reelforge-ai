import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
const BASE: string | undefined = import.meta.env.VITE_API_BASE || undefined;

// The browser calls Anthropic directly with the person's own key; there is no server in between.
export const makeClient = (apiKey: string) => new Anthropic({ apiKey, baseURL: BASE, dangerouslyAllowBrowser: true, maxRetries: 4 });

/** Returns a problem to show, or null when the key works. */
export async function testKey(key: string): Promise<string | null> {
  try {
    await makeClient(key).models.retrieve(MODEL);
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected this key. Copy it again from the Console.';
    if (err instanceof Anthropic.NotFoundError) return "This key can't access Claude Opus 5.5.";
    if (err instanceof Anthropic.APIConnectionError) return "Can't reach Anthropic. Check your internet.";
    return err instanceof Error ? err.message : 'Anthropic could not check this key.';
  }
}

export type Block = Record<string, any>;
export interface Msg {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface Turn {
  content: Block[];
  stopReason: string | null;
  stopExplanation: string | null;
  costUsd: number;
  /** tool_use id to the raw text, for tool input that wasn't valid JSON. */
  invalid: Map<string, string>;
}

export class Stopped extends Error {}

export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Settings.';
  if (err instanceof Anthropic.RateLimitError) return "Anthropic's rate limit was reached. Press Continue in a little while.";
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Anthropic. Check your internet, then press Continue.";
  if (err instanceof Anthropic.InternalServerError) return 'Anthropic is having trouble. Press Continue in a little while.';
  if (err instanceof Anthropic.APIError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return detail ? `Anthropic: ${detail}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** List prices for Opus 5.5. A server-side fallback bills at its own model's rates, so this is an estimate. */
function estimateCost(u: Record<string, number | null | undefined>): number {
  const n = (k: string) => u[k] ?? 0;
  return (n('input_tokens') * 4 + n('output_tokens') * 20 + n('cache_read_input_tokens') * 0.2 + n('cache_creation_input_tokens') * 5) / 1e6;
}

export async function streamTurn(client: Anthropic, body: Record<string, unknown>, signal: AbortSignal, onText: (text: string) => void): Promise<Turn> {
  // The SDK retries a failed request. This also covers a stream cut off midway or unparseable tool input.
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Stopped();
    try {
      const stream = client.beta.messages.stream(
        {
          ...body,
          model: MODEL,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as unknown as Parameters<typeof client.beta.messages.stream>[0],
        { signal },
      );
      const raw = new Map<number, string>();
      let live = '';
      stream.on('streamEvent', (e) => {
        if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') raw.set(e.index, (raw.get(e.index) ?? '') + e.delta.partial_json);
      });
      stream.on('text', (delta) => {
        live += delta;
        onText(live);
      });
      const message = await stream.finalMessage();
      // Plain data only, so it stores and replays exactly as the API sent it.
      const content: Block[] = JSON.parse(JSON.stringify(message.content));
      const invalid = new Map<string, string>();
      content.forEach((b, i) => {
        if (b.type !== 'tool_use') return;
        const text = raw.get(i);
        if (!text) return;
        // The SDK's parser is tolerant and can return a cut-off object, so check strictly.
        try {
          JSON.parse(text);
        } catch {
          invalid.set(b.id, text);
        }
      });
      const details = message.stop_details as { explanation?: string } | null | undefined;
      return { content, stopReason: message.stop_reason, stopExplanation: details?.explanation ?? null, costUsd: estimateCost(message.usage as unknown as Record<string, number>), invalid };
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new Stopped();
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const lasting = status !== undefined && status < 500 && status !== 429;
      if (lasting || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, (attempt + 1) ** 2 * 3000));
    }
  }
}

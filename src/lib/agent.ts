import type Anthropic from '@anthropic-ai/sdk';
import { Stopped, friendlyError, makeClient, streamTurn, type Block, type Msg, type Turn } from './claude';
import { fileList, filePut } from './db';
import { synthVoice, transcribeAudio } from './voice';
import { RenderStopped, SHARED_ASSETS, blobToBase64, imageView, mediaInfo, readFile, readMedia, renderVideo, snapshots, videoFrames, type RenderProgress } from './render';
import { activeVoiceName, getSkill, listSkills, saveProject, settings, sttReady, voiceProviderLabel, voiceReady, type ProjectMeta, type Status } from './store';
import { kvGet, kvSet } from './db';
import { desktop, ENGINE_LABEL, type AgentEvent, type McpContent } from './desktop';

export const CONTENT_TYPES: Record<string, { title: string; blurb: string; brief: string }> = {
  edit: { title: 'Edit my video', blurb: 'Footage in, polished video out.', brief: 'Edit this video. This is an [Intro Video For How To Edit Video with Claude Opus 5.5] where I have discussed [the exact steps to edit videos]. Add some motion graphics, strong icon animations, proper text, and relevant sound effects. Before editing, go through the entire video, understand the content, and tell me what can be improved.' },
  promo: { title: 'Promo from script', blurb: 'A script becomes an animated film.', brief: 'Make an animated promo video for [product] from this script. Add strong icon animations, proper text and sound effects.\n\nScript:\n' },
  saas: { title: 'SaaS or app explainer', blurb: 'Show what a product does.', brief: 'Make an explainer video for [product name], a [what it does] for [who it is for]. Main features: [feature 1], [feature 2], [feature 3]. Website: [url].' },
  tournament: { title: 'Tournament or event', blurb: 'Announcements, prizes, results.', brief: 'Make a hype announcement video for [tournament name]. Game: [game]. Date: [date]. Prize: [prize]. Entry: [how to join].' },
  custom: { title: 'Anything else', blurb: 'Describe it in your own words.', brief: '' },
};

export const STYLES: Record<string, { title: string; blurb: string }> = {
  auto: { title: 'Choose for me', blurb: 'Picks what fits the content.' },
  'brand-motion': { title: 'Brand Motion', blurb: 'Animated scenes in brand colours, with icons acting out each line.' },
  'clean-tips': { title: 'Clean Tips', blurb: 'Big plain captions and white chapter cards. For tips and how-tos.' },
  'glass-ui': { title: 'Glass UI', blurb: 'Heavy blue titles and interface popups. For premium and SaaS.' },
  'editorial-bangla': { title: 'Editorial Bangla', blurb: 'Oversized Bangla captions with gold serif emphasis.' },
  'neon-reels': { title: 'Neon Reels', blurb: 'Glowing neon captions, glass cards, emoji rain, colour grade and punch-in zooms. For talking-head reels.' },
};

const BUILT_IN_SKILLS = new Set(['core', 'edit', 'recipes', 'style-clean-tips', 'style-glass-ui', 'style-editorial-bangla', 'style-neon-reels', ...['hook', 'brand', 'welcome', 'referral', 'free', 'butwait', 'pc', 'auto', 'anticheat', 'cta', 'endcard', 'neon-reels'].map((n) => `examples/${n}`)]);

const str = { type: 'string' };
const nums = { type: 'array', items: { type: 'number' } };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ name, description, eager_input_streaming: true, input_schema: { type: 'object', properties, required } });

const TOOLS = [
  tool('read_skill', "Load know-how: core, edit, recipes, style-clean-tips, style-glass-ui, style-editorial-bangla, style-neon-reels, examples/<hook|brand|welcome|referral|free|butwait|pc|auto|anticheat|cta|endcard|neon-reels>, or my/<name> for the person's own skills.", { name: str }, ['name']),
  tool('list_files', 'List the files in the project. Pass path "assets" to also list the shared assets.', { path: str }, []),
  tool('read_file', 'Read a text file, or look at an image.', { path: str }, ['path']),
  tool('write_file', 'Create or replace a text file, usually index.html or project.json.', { path: str, contents: str }, ['path', 'contents']),
  tool('edit_file', 'Replace one exact, unique piece of text in a file.', { path: str, old_text: str, new_text: str }, ['path', 'old_text', 'new_text']),
  tool('media_info', 'Length, size and whether a video or audio file has sound.', { path: str }, ['path']),
  tool('video_frames', 'See frames from a video file at the given seconds. At most 12 per call.', { path: str, times: nums }, ['path', 'times']),
  tool('snapshot', 'See the current composition at the given seconds. At most 12 per call. Reports page errors.', { times: nums }, ['times']),
  tool('render', 'Render the MP4 into renders/. Use only after a go-ahead, unless on Autopilot.', {}, []),
  tool('generate_voice', "Speak exact text with the person's configured voice into an mp3. Costs their voice-provider credits per character.", { text: str, out: str, language: { type: 'string', description: 'ISO 639-1 code such as bn or en' } }, ['text', 'out']),
  tool('transcribe', 'Get word timings from a voice or video file through the configured voice provider. Costs their credits by length. Saves to words.json.', { path: str, language: str }, ['path']),
];

const SCHEMAS = new Map(TOOLS.map((t) => [t.name, t.input_schema]));

/** The same tools, offered to AI CLIs over MCP by the desktop app. */
const MCP_TOOLS = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));

/** Turns a tool result into MCP content: text stays text, frames become images. */
function toMcp(block: Block): { content: McpContent[]; isError?: boolean } {
  const parts: McpContent[] = [];
  const add = (c: unknown) => {
    if (typeof c === 'string') parts.push({ type: 'text', text: c });
    else if (Array.isArray(c)) c.forEach(add);
    else if (c && typeof c === 'object') {
      const b = c as Block;
      if (b.type === 'text') parts.push({ type: 'text', text: String(b.text ?? '') });
      else if (b.type === 'image') parts.push({ type: 'image', data: b.source?.data, mimeType: b.source?.media_type ?? 'image/jpeg' });
      else parts.push({ type: 'text', text: JSON.stringify(b) });
    }
  };
  add(block.content);
  if (!parts.length) parts.push({ type: 'text', text: 'Done.' });
  return { content: parts, isError: Boolean(block.is_error) };
}

/** What an AI CLI needs to know on top of the system prompt. */
const cliNote = (engine: string) => `

# Running in ReelForge Desktop through ${ENGINE_LABEL[engine] ?? engine}
- Your working folder is this project's folder: index.html, project.json, words.json, input/ and renders/ live here. Edit them with your own file tools or with the reelforge tools; both write the same files.
- The video tools are on the MCP server "reelforge": read_skill, list_files, read_file, write_file, edit_file, media_info, video_frames, snapshot, render, generate_voice, transcribe. Your CLI may show them as mcp__reelforge__<name> or reelforge.<name>. Use them; they are how you see and make the video.
- Look at images with the reelforge read_file tool, footage with video_frames and your composition with snapshot.
- Shared assets are not files in this folder. Reference them in index.html as assets/<path>, and see them with list_files path "assets".
- Don't run shell commands, install software, or touch anything outside this folder.
- When you need the person's answer or go-ahead, end your turn with the question. Their reply arrives as your next message.`;

/** Tool input streams unchecked by the API, so it's checked against the schema here. */
function schemaProblem(name: string, input: Record<string, unknown>): string | null {
  const schema = SCHEMAS.get(name);
  if (!schema) return 'Unknown tool.';
  for (const key of schema.required) {
    if (input[key] === undefined || input[key] === null || input[key] === '') return `Missing "${key}".`;
  }
  for (const [key, rule] of Object.entries(schema.properties) as [string, { type: string; items?: { type: string } }][]) {
    const v = input[key];
    if (v === undefined) continue;
    if (rule.type === 'string' && typeof v !== 'string') return `"${key}" must be text.`;
    if (rule.type === 'array' && !(Array.isArray(v) && v.every((x) => typeof x === rule.items?.type))) return `"${key}" must be a list of numbers.`;
  }
  return null;
}

export interface FeedEvent {
  kind: 'user' | 'agent' | 'tool' | 'error' | 'notice';
  text: string;
  detail?: string;
}

const textFile = (text: string) => new Blob([text], { type: 'text/plain;charset=utf-8' });

async function asset(path: string): Promise<string> {
  const res = await fetch(new URL(path, document.baseURI).href);
  if (!res.ok) throw new Error(`${path} is missing from this site.`);
  return res.text();
}

// Only one render at a time, so several projects can't exhaust the browser's memory together.
let renderQueue: Promise<unknown> = Promise.resolve();

/** Drives one project's agent. It keeps running while the person looks at other screens. */
export class AgentController {
  private static live = new Map<string, AgentController>();

  static async of(meta: ProjectMeta): Promise<AgentController> {
    let c = this.live.get(meta.id);
    if (!c) {
      c = new AgentController(meta);
      this.live.set(meta.id, c);
      c.events = (await kvGet<FeedEvent[]>(`events:${meta.id}`)) ?? [];
      await c.refreshOutputs();
    }
    return c;
  }

  static peek = (id: string) => this.live.get(id);
  static forget = (id: string) => this.live.delete(id);
  static anyWorking = () => [...this.live.values()].some((c) => c.working);

  events: FeedEvent[] = [];
  working = false;
  liveText = '';
  renderInfo: RenderProgress | null = null;
  outputs: string[] = [];
  version = 0;

  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private lastPaint = 0;

  private constructor(public meta: ProjectMeta) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
    AgentController.onAnyChange?.();
  }
  static onAnyChange: (() => void) | null = null;

  private add(e: FeedEvent) {
    this.events = [...this.events, e];
    this.notify();
  }

  /** Streaming text arrives quickly; painting a little less often keeps the page smooth. */
  private paintSoon() {
    const now = performance.now();
    if (now - this.lastPaint > 80) {
      this.lastPaint = now;
      this.notify();
    }
  }

  private async persist() {
    this.meta.updatedAt = Date.now();
    await Promise.all([kvSet(`events:${this.meta.id}`, this.events), saveProject(this.meta)]);
  }

  private async refreshOutputs() {
    const files = await fileList(this.meta.id);
    const n = (p: string) => Number(/video-(\d+)/.exec(p)?.[1] ?? 0);
    this.outputs = files.filter((f) => f.startsWith('renders/') && f.endsWith('.mp4')).sort((a, b) => n(b) - n(a));
  }

  stop() {
    this.abort.abort();
    if (this.jobId) void desktop?.agentStop(this.jobId);
  }

  private safe(path: string): string {
    const clean = path.replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
    if (clean.split('/').includes('..') || !clean) throw new Error('That path is outside the project.');
    return clean;
  }

  private async system(): Promise<string> {
    let s = await asset('skills/system.md');
    if (voiceReady()) {
      s += `\n\n${voiceProviderLabel()} is set up for voiceover, with voice "${activeVoiceName()}".`;
      s += sttReady() ? ' transcribe is available for word timings.' : ' transcribe (word timings) is not available, so estimate timing from letter counts and say so.';
    } else {
      s += '\n\nNo voice provider is set up, so generate_voice and transcribe will fail. If a job needs them, tell the person to add ElevenLabs or Cartesia in Settings.';
    }
    const mine = await listSkills();
    if (mine.length) {
      s += "\n\nThe person's own skills, read with read_skill my/<name>, and use whenever one fits:\n";
      for (const m of mine) s += `- ${m.name}: ${m.description}\n`;
    }
    if (settings.masterPrompt.trim()) {
      s += `\n\nThe person's Master prompt follows. Follow it on every video, unless a job's brief says otherwise. It can set style, tone, brand and habits. Being honest about limits, and not inventing claims, still comes first.\n<master_prompt>\n${settings.masterPrompt.trim()}\n</master_prompt>`;
    }
    return s;
  }

  firstPrompt(brief: string): string {
    const { meta } = this;
    const type = CONTENT_TYPES[meta.type] ?? CONTENT_TYPES.custom;
    const style = STYLES[meta.style] ?? STYLES.auto;
    let b = `# New video job\n\n## What the person wrote\n${brief.trim() || '(nothing written; work from the files)'}\n\n## Settings\n- Type: ${type.title}\n- Style: ${style.title}${meta.style === 'auto' ? ' (choose what fits, and say which)' : ''}\n- Shape: ${meta.aspect === 'source' ? 'match the source footage' : meta.aspect}\n- On-screen language: ${meta.language === 'auto' ? 'same as the speech or script' : meta.language}\n`;
    if (meta.voiceover) b += `- Voiceover: generate it with ${voiceProviderLabel()} from the script, after checking the words\n`;
    b += '\n## Files\n';
    b += meta.inputs.length ? meta.inputs.map((f) => `- input/${f}\n`).join('') : '- none supplied\n';
    b += '\n## How to start\nRead skill `core`';
    if (meta.type === 'edit') b += ' and `edit`';
    if (meta.style !== 'auto' && meta.style !== 'brand-motion') b += ` and \`style-${meta.style}\``;
    b += ' first. ';
    b += meta.autopilot
      ? 'Autopilot is on: do not stop for approval unless truly blocked. Still do the audit, and put it and anything unverified in your final report.'
      : 'Work in stages: go through the inputs, report what you found, what can be improved and your plan, then stop and wait for a go-ahead before building. Stop again if something important changes.';
    return b;
  }

  private call(client: Anthropic, system: string, messages: Msg[]): Promise<Turn> {
    return streamTurn(
      client,
      {
        max_tokens: 64000,
        cache_control: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
        output_config: { effort: settings.effort },
        system,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }, ...TOOLS],
        messages,
      },
      this.abort.signal,
      (t) => {
        this.liveText = t;
        this.paintSoon();
      },
    ).then((turn) => {
      this.liveText = '';
      this.meta.costUsd += turn.costUsd;
      return turn;
    });
  }

  /** A request can only carry so many images and megabytes, and every frame looked at stays in the history. */
  private historyIsFull(messages: Msg[]): boolean {
    let images = 0;
    let bytes = 0;
    const scan = (content: unknown) => {
      if (!Array.isArray(content)) return;
      for (const b of content as Block[]) {
        if (b.type === 'image') {
          images++;
          bytes += String(b.source?.data ?? '').length;
        } else if (b.type === 'tool_result') scan(b.content);
      }
    };
    messages.forEach((m) => scan(m.content));
    return images >= 70 || bytes >= 16_000_000;
  }

  /** Starts a fresh history from the agent's own notes, keeping the original brief word for word. */
  private async handOff(client: Anthropic, system: string, messages: Msg[]) {
    this.add({ kind: 'tool', text: 'Tidying its notes' });
    const last = messages[messages.length - 1];
    const ask = { type: 'text', text: 'The frames you have looked at are about to leave your memory, because the request is full. Write a complete handoff note for yourself now, without using tools: the decisions made, what the person approved or asked for since the brief, what is built and in which files, what you saw that still matters (with times), and exactly what is left to do.' };
    const turn = await this.call(client, system, [...messages.slice(0, -1), { role: 'user', content: [...last.content, ask] }]);
    const note = turn.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const first = messages[0].content;
    messages.length = 0;
    messages.push({ role: 'user', content: [...first, { type: 'text', text: `\n\n# Your handoff note from earlier in this job\nImages from before this point are gone; look again if you need them.\n\n${note}\n\nContinue from here.` }] });
  }

  /** Recent conversation as plain text, for an AI that joins a project midway. */
  private recap(): string {
    return this.events
      .filter((e) => e.kind === 'user' || e.kind === 'agent')
      .slice(-24)
      .map((e) => `${e.kind === 'user' ? 'Person' : 'Agent'}: ${e.text.length > 1500 ? `${e.text.slice(0, 1500)}...` : e.text}`)
      .join('\n\n');
  }

  /** The first prompt of the job, kept so another engine can pick the project up later. */
  private async briefFor(text: string): Promise<{ brief: string; fresh: boolean }> {
    const key = `brief:${this.meta.id}`;
    const stored = await kvGet<string>(key);
    if (stored) return { brief: stored, fresh: false };
    await kvSet(key, text);
    return { brief: text, fresh: true };
  }

  async send(display: string, prompt?: string): Promise<void> {
    if (this.working) return;
    if (settings.engine !== 'api' && desktop) return this.sendCli(display, prompt);
    this.working = true;
    this.abort = new AbortController();
    this.liveText = '';
    this.meta.status = 'working';
    this.add({ kind: 'user', text: display });
    let wake: WakeLockSentinel | undefined;
    try {
      wake = await navigator.wakeLock?.request('screen');
    } catch {
      // Not offered here. The work still runs while the tab stays open.
    }

    const key = `messages:${this.meta.id}`;
    const messages: Msg[] = (await kvGet<Msg[]>(key)) ?? [];
    let text = prompt ?? display;
    const { brief, fresh } = await this.briefFor(text);
    // A project another engine started: give this one the brief and the story so far.
    if (!messages.length && !fresh) text = `${brief}\n\n# The conversation so far (with another AI)\n${this.recap()}\n\n# The person's new message\n${text}`;
    messages.push({ role: 'user', content: [{ type: 'text', text }] });

    let finalStatus: Status = 'waiting';
    try {
      const client = makeClient(settings.anthropicKey);
      const system = await this.system();
      for (let turns = 1; ; turns++) {
        if (this.abort.signal.aborted) throw new Stopped();
        if (this.meta.costUsd >= settings.budgetUsd) {
          this.add({ kind: 'error', text: `This project reached its budget limit of ${settings.budgetUsd} USD, so it paused. Raise the limit in Settings, then press Continue.` });
          finalStatus = 'stopped';
          break;
        }
        if (turns > 120) {
          this.add({ kind: 'error', text: 'The agent took too many steps, so it paused. Press Continue to carry on.' });
          finalStatus = 'stopped';
          break;
        }
        if (messages[messages.length - 1].role === 'user' && this.historyIsFull(messages)) {
          await this.handOff(client, system, messages);
          await kvSet(key, messages);
        }

        const turn = await this.call(client, system, messages);
        if (this.abort.signal.aborted) throw new Stopped();

        // A paused turn resumes in place, so its continuation belongs to the same assistant message.
        const previous = messages[messages.length - 1];
        if (previous.role === 'assistant') previous.content.push(...turn.content);
        else messages.push({ role: 'assistant', content: turn.content });

        for (const b of turn.content) {
          if (b.type === 'text' && String(b.text ?? '').trim()) this.add({ kind: 'agent', text: b.text });
          if (b.type === 'server_tool_use') this.add({ kind: 'tool', text: b.name === 'web_search' ? 'Searching the web' : 'Reading a web page', detail: String(b.input?.query ?? b.input?.url ?? '') });
        }

        if (turn.stopReason === 'refusal') {
          this.add({ kind: 'error', text: `The model declined this request${turn.stopExplanation ? `: ${turn.stopExplanation}` : '.'} Try wording it differently.` });
          messages.pop(); // a refused turn isn't replayed
          finalStatus = 'error';
          break;
        }
        if (turn.stopReason === 'pause_turn') continue;
        const calls = turn.content.filter((b) => b.type === 'tool_use');
        if (turn.stopReason === 'max_tokens') {
          // A cut-off tool call must not run. Ask for smaller pieces instead.
          messages.push({
            role: 'user',
            content: calls.length
              ? calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Cut off at the output limit. Nothing ran. Write a smaller file, or split the work.' }))
              : [{ type: 'text', text: 'You were cut off at the output limit. Continue, in smaller pieces.' }],
          });
          continue;
        }
        if (!calls.length) break;

        const results: Block[] = [];
        for (const call of calls) {
          if (turn.invalid.has(call.id)) {
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: turn.invalid.get(call.id) }) });
            continue;
          }
          results.push(await this.runTool(call));
        }
        messages.push({ role: 'user', content: results });
        await kvSet(key, messages);
        await this.persist();
        this.notify();
      }
    } catch (err) {
      if (err instanceof Stopped || err instanceof RenderStopped) {
        this.add({ kind: 'notice', text: 'Stopped.' });
        finalStatus = 'stopped';
      } else {
        this.add({ kind: 'error', text: friendlyError(err) });
        finalStatus = 'error';
      }
    }

    // History must stay valid: a turn that asked for tools has to be answered, even after a stop.
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      const open = last.content.filter((b) => b.type === 'tool_use');
      if (open.length) messages.push({ role: 'user', content: open.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Stopped by the person.' })) });
    }
    await kvSet(key, messages);

    await wake?.release().catch(() => undefined);
    this.working = false;
    this.renderInfo = null;
    this.liveText = '';
    await this.refreshOutputs();
    if (finalStatus === 'waiting' && this.outputs.length) finalStatus = 'done';
    this.meta.status = finalStatus;
    await this.persist();
    this.notify();
  }

  private jobId: string | null = null;

  /** One turn with an AI CLI on this PC. It works in the project folder and calls the tools above over MCP. */
  private async sendCli(display: string, prompt?: string): Promise<void> {
    const api = desktop!;
    const engine = settings.engine;
    this.working = true;
    this.abort = new AbortController();
    this.liveText = '';
    this.meta.status = 'working';
    this.add({ kind: 'user', text: display });

    const text = prompt ?? display;
    const { brief, fresh } = await this.briefFor(text);
    const sessions = (this.meta.cliSessions ??= {});
    let finalStatus: Status = 'waiting';

    const turn = async (session: string | null): Promise<{ gotAnything: boolean; failed: boolean }> => {
      let message = text;
      let system: string | undefined;
      if (!session) {
        system = (await this.system()) + cliNote(engine);
        if (!fresh) message = `${brief}\n\n# The conversation so far\n${this.recap()}\n\n# The person's new message\n${text}`;
      }
      const jobId = crypto.randomUUID();
      this.jobId = jobId;
      let gotAnything = false;
      let failed = false;
      const off = api.onAgentEvent((e: AgentEvent) => {
        if (e.jobId !== jobId) return;
        switch (e.type) {
          case 'session':
            sessions[engine] = e.id;
            break;
          case 'delta':
            this.liveText = e.text;
            this.paintSoon();
            break;
          case 'text':
            gotAnything = true;
            this.liveText = '';
            this.add({ kind: 'agent', text: e.text });
            break;
          case 'tool':
            gotAnything = true;
            this.add({ kind: 'tool', text: e.text, detail: e.detail });
            break;
          case 'error':
            failed = true;
            // Some CLIs print the same problem as a message and again as the error result.
            if (!this.abort.signal.aborted && this.events.at(-1)?.text.trim() !== e.text.trim()) this.add({ kind: 'error', text: e.text });
            break;
          case 'result':
            if (!e.ok) failed = true;
            break;
        }
      });
      try {
        await api.agentStart({ jobId, projectId: this.meta.id, engine, model: settings.engineModels[engine] ?? '', effort: settings.effort, prompt: message, system, session });
      } finally {
        off();
        this.jobId = null;
      }
      return { gotAnything, failed };
    };

    try {
      const session = sessions[engine] ?? null;
      let r = await turn(session);
      // A conversation the CLI no longer has: start a fresh one that carries the story so far.
      if (session && r.failed && !r.gotAnything && !this.abort.signal.aborted) {
        delete sessions[engine];
        this.add({ kind: 'notice', text: `Starting a new ${ENGINE_LABEL[engine]} conversation for this project.` });
        r = await turn(null);
      }
      if (this.abort.signal.aborted) {
        this.add({ kind: 'notice', text: 'Stopped.' });
        finalStatus = 'stopped';
      } else if (r.failed) finalStatus = 'error';
    } catch (err) {
      this.add({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      finalStatus = 'error';
    }

    this.working = false;
    this.renderInfo = null;
    this.liveText = '';
    await this.refreshOutputs();
    if (finalStatus === 'waiting' && this.outputs.length) finalStatus = 'done';
    this.meta.status = finalStatus;
    await this.persist();
    this.notify();
  }

  /** A tool call from an AI CLI, through the desktop app's MCP server. */
  async mcpCall(jobId: string, name: string, args: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
    if (!this.working || this.jobId !== jobId) return { content: [{ type: 'text', text: 'This job was stopped in ReelForge.' }], isError: true };
    try {
      const block = await this.runTool({ id: 'mcp', name, input: args });
      await this.refreshOutputs();
      this.notify();
      return toMcp(block);
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Stopped ? 'Stopped by the person.' : err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  private ok = (id: string, content: unknown): Block => ({ type: 'tool_result', tool_use_id: id, content });
  private err = (id: string, message: string): Block => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: message });

  private async imageBlocks(times: number[], frames: Blob[]): Promise<Block[]> {
    const out: Block[] = [];
    for (let i = 0; i < frames.length; i++) {
      out.push({ type: 'text', text: `t=${times[i]}s` });
      out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(frames[i]) } });
    }
    return out;
  }

  private async runTool(call: Block): Promise<Block> {
    const id: string = call.id;
    const name: string = call.name;
    const a: Record<string, any> = call.input ?? {};
    const pid = this.meta.id;
    const log = (text: string, detail?: string) => this.add({ kind: 'tool', text, detail });
    const problem = schemaProblem(name, a);
    if (problem) return this.err(id, problem);

    try {
      switch (name) {
        case 'read_skill': {
          const n: string = a.name;
          log('Loading know-how', n);
          if (n.startsWith('my/')) {
            const skill = await getSkill(n.slice(3));
            return skill ? this.ok(id, skill.text) : this.err(id, 'No such skill.');
          }
          if (!BUILT_IN_SKILLS.has(n)) return this.err(id, 'No such skill.');
          return this.ok(id, await asset(`skills/${n}${n.startsWith('examples/') ? '.html' : '.md'}`));
        }
        case 'list_files': {
          const own = await fileList(pid);
          const path: string = a.path ?? '';
          const all = path.startsWith('assets') ? [...new Set([...own, ...SHARED_ASSETS])] : own;
          const items = all.filter((f) => f.startsWith(path)).sort();
          return this.ok(id, items.length ? items.join('\n') : '(empty)');
        }
        case 'read_file': {
          const path = this.safe(a.path);
          log('Looking at a file', path);
          const file = await readFile(pid, path);
          if (!file) return this.err(id, 'File not found.');
          if (/\.(png|jpe?g|webp)$/i.test(path)) {
            return this.ok(id, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(await imageView(file)) } }]);
          }
          if (file.size > 400_000) return this.err(id, 'Too large to read as text.');
          return this.ok(id, await file.text());
        }
        case 'write_file': {
          const path = this.safe(a.path);
          log('Writing', path);
          await filePut(pid, path, textFile(a.contents));
          return this.ok(id, `Saved ${path}.`);
        }
        case 'edit_file': {
          const path = this.safe(a.path);
          log('Editing', path);
          const file = await readFile(pid, path);
          if (!file) return this.err(id, 'File not found.');
          const text = await file.text();
          const hits = text.split(a.old_text).length - 1;
          if (hits !== 1) return this.err(id, `old_text must appear exactly once; it appears ${hits} times.`);
          // A replacer function, so "$" in the new text stays literal.
          await filePut(pid, path, textFile(text.replace(a.old_text, () => a.new_text ?? '')));
          return this.ok(id, `Edited ${path}.`);
        }
        case 'media_info': {
          const path = this.safe(a.path);
          log('Measuring', path);
          const file = await readMedia(pid, path);
          return file ? this.ok(id, JSON.stringify(await mediaInfo(file))) : this.err(id, 'File not found.');
        }
        case 'video_frames': {
          const path = this.safe(a.path);
          const times: number[] = a.times.slice(0, 12);
          log('Watching the video', `${times.length} frames`);
          const file = await readMedia(pid, path);
          if (!file) return this.err(id, 'File not found.');
          return this.ok(id, await this.imageBlocks(times, await videoFrames(file, times)));
        }
        case 'snapshot': {
          const times: number[] = a.times.slice(0, 12);
          log('Reviewing frames', `${times.length} frames`);
          return this.ok(id, await this.imageBlocks(times, await snapshots(pid, times)));
        }
        case 'render':
          return await this.runRender(id);
        case 'generate_voice': {
          if (!voiceReady()) return this.err(id, 'No voice provider is set up. Tell the person to add it in Settings.');
          if (a.text.length > 10000) return this.err(id, 'At most 10000 characters per call.');
          const out = this.safe(a.out);
          log('Making the voiceover', `${a.text.length} characters`);
          const blob = await synthVoice(a.text, a.language);
          await filePut(pid, out, blob);
          return this.ok(id, `Saved ${out}. ${JSON.stringify(await mediaInfo(blob))}`);
        }
        case 'transcribe': {
          if (!sttReady()) return this.err(id, 'No voice provider is set up, so there are no word timings. Estimate from letter counts, and say so.');
          const path = this.safe(a.path);
          log('Measuring the speech', path);
          const file = await readFile(pid, path);
          if (!file) return this.err(id, 'File not found.');
          const words = await transcribeAudio(file, path.split('/').pop() ?? 'audio', a.language);
          await filePut(pid, 'words.json', textFile(JSON.stringify(words)));
          return this.ok(id, JSON.stringify(words));
        }
        default:
          return this.err(id, 'Unknown tool.');
      }
    } catch (err) {
      if (err instanceof RenderStopped || this.abort.signal.aborted) throw new Stopped();
      return this.err(id, err instanceof Error ? err.message : String(err));
    }
  }

  /** The editor's Export button: renders straight away, without the AI. Returns the new file, or null. */
  async exportVideo(shortSide: number): Promise<string | null> {
    if (this.working) return null;
    this.working = true;
    this.abort = new AbortController();
    this.meta.status = 'working';
    this.notify();
    let out: string | null = null;
    try {
      const block = await this.runRender('export', shortSide);
      out = /renders\/video-\d+\.mp4/.exec(String(block.content))?.[0] ?? null;
      this.add({ kind: 'notice', text: `Exported ${out ?? 'the video'}.` });
    } catch (err) {
      if (err instanceof RenderStopped || this.abort.signal.aborted) this.add({ kind: 'notice', text: 'Export stopped.' });
      else this.add({ kind: 'error', text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    this.working = false;
    await this.refreshOutputs();
    this.meta.status = this.outputs.length ? 'done' : 'waiting';
    await this.persist();
    this.notify();
    return out;
  }

  private async runRender(id: string, shortSide = settings.exportShortSide): Promise<Block> {
    this.add({ kind: 'tool', text: 'Rendering the video' });
    const ahead = renderQueue;
    let finished!: () => void;
    renderQueue = new Promise<void>((r) => (finished = r));
    await ahead;
    try {
      if (this.abort.signal.aborted) throw new RenderStopped();
      await this.refreshOutputs();
      const n = this.outputs.reduce((max, p) => Math.max(max, Number(/video-(\d+)/.exec(p)?.[1] ?? 0)), 0) + 1;
      const out = `renders/video-${n}.mp4`;
      const started = Date.now();
      const blob = await renderVideo(this.meta.id, shortSide, this.abort.signal, (p) => {
        this.renderInfo = p;
        this.notify();
      });
      await filePut(this.meta.id, out, blob);
      await this.refreshOutputs();
      const secs = Math.round((Date.now() - started) / 1000);
      return this.ok(id, `Rendered ${out} in ${secs}s. ${JSON.stringify(await mediaInfo(blob))}. Check it with video_frames.`);
    } finally {
      this.renderInfo = null;
      finished();
    }
  }
}

// The desktop app's MCP server asks the open project to run each tool an AI CLI calls.
if (desktop) {
  void desktop.setTools(MCP_TOOLS);
  desktop.onToolCall(async (c) => {
    const ctl = AgentController.peek(c.projectId);
    const result = ctl ? await ctl.mcpCall(c.jobId, c.name, c.args) : { content: [{ type: 'text' as const, text: 'This project is not open in ReelForge.' }], isError: true };
    desktop!.toolResult(c.callId, result);
  });
}

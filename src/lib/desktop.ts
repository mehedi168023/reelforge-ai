// What the desktop app (Electron) adds. In a plain browser `desktop` is null and everything works as before.

export interface EngineInfo {
  id: string;
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  install: string;
}

export interface ImportProgress {
  id: string;
  name: string;
  stage: 'copy' | 'convert';
  fraction: number | null;
  reasons?: string[];
}

export type AgentEvent = { jobId: string } & (
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; text: string; detail?: string }
  | { type: 'error'; text: string }
  | { type: 'result'; ok: boolean }
  | { type: 'exit' }
);

export interface ToolCall {
  callId: string;
  jobId: string;
  projectId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface McpContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface DesktopApi {
  info(): Promise<{ root: string; version: string; media: { ffmpeg: string | null; ffprobe: string | null; encoder: string | null } }>;
  fileUrl(id: string, rel: string): string;
  put(id: string, rel: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  list(id: string): Promise<string[]>;
  exists(id: string, rel: string): Promise<boolean>;
  deleteAll(id: string): Promise<void>;
  reveal(id: string, rel?: string): Promise<void>;
  open(id: string, rel: string): Promise<string>;
  saveAs(id: string, rel: string, suggested: string): Promise<string | null>;
  pathForFile(file: File): string | null;
  importFile(id: string, src: string, name: string): Promise<{ name: string; converted: string | null }>;
  onImportProgress(fn: (p: ImportProgress) => void): () => void;
  audioOf(id: string, rel: string): Promise<string | null>;
  /** Flattens edited clips into one cached video through the native engine; returns its project path. */
  compose(id: string, job: { clips: unknown[]; width: number; height: number; fps: number; duration: number }): Promise<string>;
  /** Peaks for drawing a sound's waveform, from the native engine. */
  waveform(id: string, rel: string, points: number): Promise<number[]>;
  /** Length in seconds of a media file. */
  probe(id: string, rel: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }>;
  onEngineProgress(fn: (p: { id: string; fraction: number }) => void): () => void;
  kvGet<T>(key: string): Promise<T | undefined>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvDel(key: string): Promise<void>;
  kvValues<T>(prefix: string): Promise<T[]>;
  kvCount(): Promise<number>;
  kvImport(entries: [string, unknown][]): Promise<void>;
  historyAdd(id: string, label: string, projectJson: string | null, indexHtml: string | null): Promise<number | null>;
  historyList(id: string): Promise<{ id: number; at: number; label: string }[]>;
  historyGet(hid: number): Promise<{ project: string; projectJson: string | null; indexHtml: string | null } | null>;
  historyDrop(id: string): Promise<void>;
  detectEngines(): Promise<EngineInfo[]>;
  setTools(tools: unknown[]): Promise<void>;
  onToolCall(fn: (c: ToolCall) => void): () => void;
  toolResult(callId: string, result: { content: McpContent[]; isError?: boolean }): void;
  agentStart(job: { jobId: string; projectId: string; engine: string; model: string; effort: string; prompt: string; system?: string; session?: string | null }): Promise<void>;
  agentStop(jobId: string): Promise<void>;
  onAgentEvent(fn: (e: AgentEvent) => void): () => void;
}

export const desktop: DesktopApi | null = (globalThis as { rfDesktop?: DesktopApi }).rfDesktop ?? null;

/** The engines found on this PC, asked once per app start. */
let engineList: Promise<EngineInfo[]> | null = null;
export const detectEngines = (fresh = false): Promise<EngineInfo[]> => {
  if (!desktop) return Promise.resolve([]);
  if (fresh || !engineList) engineList = desktop.detectEngines().catch(() => []);
  return engineList;
};

export const ENGINE_LABEL: Record<string, string> = {
  api: 'Claude API (your key)',
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
  gemini: 'Gemini CLI',
};

/** Model names each CLI understands, offered as suggestions; any other name can be typed. */
export const ENGINE_MODELS: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra'],
  agy: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6'],
  gemini: [],
};

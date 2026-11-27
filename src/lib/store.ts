import { fileDeleteAll, filePut, kvDel, kvGet, kvSet, kvValues } from './db';
import { desktop } from './desktop';

export interface Settings {
  anthropicKey: string;
  voiceProvider: 'elevenlabs' | 'cartesia';
  elevenKey: string;
  voiceId: string;
  voiceName: string;
  voiceModel: string;
  cartesiaKey: string;
  cartesiaVoiceId: string;
  cartesiaVoiceName: string;
  cartesiaModel: string;
  masterPrompt: string;
  effort: 'medium' | 'high' | 'xhigh' | 'max';
  budgetUsd: number;
  exportShortSide: number;
  /** Which AI does the work: 'api' (Anthropic key) or an AI CLI on this PC (desktop app only). */
  engine: string;
  /** Model per engine; empty uses the CLI's own default. */
  engineModels: Record<string, string>;
}

export interface ProjectMeta {
  id: string;
  name: string;
  type: string;
  style: string;
  aspect: string;
  language: string;
  autopilot: boolean;
  voiceover: boolean;
  inputs: string[];
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  status: Status;
  /** The AI CLI conversation this project continues, per engine. */
  cliSessions?: Record<string, string>;
}

export type Status = 'new' | 'working' | 'waiting' | 'done' | 'error' | 'stopped';

export interface MySkill {
  name: string;
  description: string;
  text: string;
}

export const settings: Settings = {
  anthropicKey: '',
  voiceProvider: 'elevenlabs',
  elevenKey: '',
  voiceId: '',
  voiceName: '',
  voiceModel: 'eleven_v4',
  cartesiaKey: '',
  cartesiaVoiceId: '',
  cartesiaVoiceName: '',
  cartesiaModel: 'sonic-3.6',
  masterPrompt: '',
  effort: 'high',
  budgetUsd: 10,
  exportShortSide: 1080,
  engine: 'api',
  engineModels: {},
};

/** Whether the chosen AI can work: the API needs a key, a CLI needs the desktop app. */
export const engineReady = () => (settings.engine === 'api' ? Boolean(settings.anthropicKey) : Boolean(desktop));

const onCartesia = () => settings.voiceProvider === 'cartesia';

/** Whether the active provider can make a voiceover: it needs a key and a voice. */
export const voiceReady = () => (onCartesia() ? Boolean(settings.cartesiaKey && settings.cartesiaVoiceId) : Boolean(settings.elevenKey && settings.voiceId));

/** Whether the active provider can transcribe for word timings: only a key is needed. */
export const sttReady = () => (onCartesia() ? Boolean(settings.cartesiaKey) : Boolean(settings.elevenKey));

/** The active provider's voice name, for messages. */
export const activeVoiceName = () => (onCartesia() ? settings.cartesiaVoiceName : settings.voiceName);

/** The active provider's display name. */
export const voiceProviderLabel = () => (onCartesia() ? 'Cartesia' : 'ElevenLabs');

export async function loadSettings(): Promise<void> {
  Object.assign(settings, (await kvGet<Partial<Settings>>('settings')) ?? {});
}

export const saveSettings = () => kvSet('settings', { ...settings });

// ---------- the person's own skills ----------
export function parseSkill(text: string): { name: string; description: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const field = (key: string) =>
    (new RegExp(`^${key}:(.*)$`, 'm').exec(m[1])?.[1] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '');
  const name = field('name');
  const description = field('description');
  return name && description ? { name, description } : null;
}

export const listSkills = () => kvValues<MySkill>('skill:').then((s) => s.sort((a, b) => a.name.localeCompare(b.name)));

export async function addSkill(text: string): Promise<string> {
  const meta = parseSkill(text);
  if (!meta) throw new Error('A skill needs a name and a description at the top of the file.');
  const name = meta.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new Error('That skill name is not usable.');
  await kvSet(`skill:${name}`, { name, description: meta.description, text });
  return name;
}

export const getSkill = (name: string) => kvGet<MySkill>(`skill:${name}`);
export const removeSkill = (name: string) => kvDel(`skill:${name}`);

// ---------- projects ----------
export const listProjects = () => kvValues<ProjectMeta>('project:').then((p) => p.sort((a, b) => b.updatedAt - a.updatedAt));
export const getProject = (id: string) => kvGet<ProjectMeta>(`project:${id}`);
export const saveProject = (p: ProjectMeta) => kvSet(`project:${p.id}`, { ...p });

export type ImportNote = (text: string) => void;

function safeName(file: File, taken: string[], index: number): string {
  let name = file.name.replace(/[^\p{L}\p{N} ._-]/gu, '_');
  if (name.startsWith('.')) name = `file${name}`;
  if (taken.includes(name)) name = `${index}-${name}`;
  return name;
}

/** Saves one picked file into input/. On the desktop it is copied from disk, and footage the renderer can't decode becomes H.264. */
async function saveInput(projectId: string, file: File, name: string, taken: string[], note?: ImportNote): Promise<string> {
  const src = desktop?.pathForFile(file);
  if (desktop && src) {
    const off = desktop.onImportProgress((p) => {
      if (p.id !== projectId || p.name !== name) return;
      if (p.stage === 'convert') note?.(`Converting ${name} (${p.reasons?.join(', ')}) ${p.fraction !== null ? `${Math.round(p.fraction * 100)}%` : ''}`);
      else note?.(`Copying ${name}`);
    });
    try {
      const r = await desktop.importFile(projectId, src, name);
      // A converted clip is saved as .mp4, which may collide with a name already taken.
      if (r.name !== name && taken.includes(r.name)) throw new Error(`${r.name} already exists in this project. Rename the file and add it again.`);
      return r.name;
    } finally {
      off();
    }
  }
  await filePut(projectId, `input/${name}`, file);
  return name;
}

export async function createProject(input: Pick<ProjectMeta, 'name' | 'type' | 'style' | 'aspect' | 'language' | 'autopilot' | 'voiceover'>, files: File[], note?: ImportNote): Promise<ProjectMeta> {
  const id = `${Date.now()}`;
  const inputs: string[] = [];
  for (const file of files) inputs.push(await saveInput(id, file, safeName(file, inputs, inputs.length), inputs, note));
  const now = Date.now();
  const meta: ProjectMeta = { ...input, id, name: input.name.trim().slice(0, 60) || 'Untitled', inputs, createdAt: now, updatedAt: now, costUsd: 0, status: 'new' };
  await saveProject(meta);
  return meta;
}

/** Add more files to an existing project mid-conversation. Returns the saved names. */
export async function addInputFiles(meta: ProjectMeta, files: File[], note?: ImportNote): Promise<string[]> {
  const added: string[] = [];
  for (const file of files) {
    const taken = [...meta.inputs, ...added];
    added.push(await saveInput(meta.id, file, safeName(file, taken, taken.length), taken, note));
  }
  meta.inputs = [...meta.inputs, ...added];
  await saveProject(meta);
  return added;
}

export async function deleteProject(id: string): Promise<void> {
  await Promise.all([kvDel(`project:${id}`), kvDel(`events:${id}`), kvDel(`messages:${id}`), kvDel(`brief:${id}`), fileDeleteAll(id), desktop?.historyDrop(id)]);
}

// Settings and conversations are kept in IndexedDB. Video files are too in a browser; the desktop app keeps
// them as real files on disk (Videos\ReelForge\<project>), so big footage and renders never sit in memory.
import { desktop } from './desktop';

const DB_NAME = 'reelforge';
let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("This browser's storage can't be opened."));
  }));
}

function run<T>(store: 'kv' | 'files', mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = work(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('Storage is full. Delete an old video and try again.'));
      }),
  );
}

export const kvGet = <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key));
export const kvDel = (key: string) => run('kv', 'readwrite', (s) => s.delete(key));

const rangeFor = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

export const kvValues = <T>(prefix: string) => run<T[]>('kv', 'readonly', (s) => s.getAll(rangeFor(prefix)));

const idbPut = (projectId: string, path: string, blob: Blob) => run('files', 'readwrite', (s) => s.put(blob, `${projectId}/${path}`));
const idbGet = (projectId: string, path: string) => run<Blob | undefined>('files', 'readonly', (s) => s.get(`${projectId}/${path}`));

export async function filePut(projectId: string, path: string, blob: Blob): Promise<void> {
  if (desktop) return desktop.put(projectId, path, new Uint8Array(await blob.arrayBuffer()));
  await idbPut(projectId, path, blob);
}

export async function fileGet(projectId: string, path: string): Promise<Blob | undefined> {
  if (!desktop) return idbGet(projectId, path);
  if (!(await desktop.exists(projectId, path))) return undefined;
  const res = await fetch(desktop.fileUrl(projectId, path));
  return res.ok ? res.blob() : undefined;
}

export async function fileList(projectId: string): Promise<string[]> {
  if (desktop) return desktop.list(projectId);
  const prefix = `${projectId}/`;
  const keys = await run<IDBValidKey[]>('files', 'readonly', (s) => s.getAllKeys(rangeFor(prefix)));
  return keys.map((k) => String(k).slice(prefix.length)).sort();
}

export async function fileDeleteAll(projectId: string): Promise<void> {
  if (desktop) return desktop.deleteAll(projectId);
  await run('files', 'readwrite', (s) => s.delete(rangeFor(`${projectId}/`)));
}

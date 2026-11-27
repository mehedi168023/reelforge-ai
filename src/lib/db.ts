// Everything is kept in this browser's IndexedDB: settings, conversations and video files.
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

export const filePut = (projectId: string, path: string, blob: Blob) => run('files', 'readwrite', (s) => s.put(blob, `${projectId}/${path}`));
export const fileGet = (projectId: string, path: string) => run<Blob | undefined>('files', 'readonly', (s) => s.get(`${projectId}/${path}`));

export async function fileList(projectId: string): Promise<string[]> {
  const prefix = `${projectId}/`;
  const keys = await run<IDBValidKey[]>('files', 'readonly', (s) => s.getAllKeys(rangeFor(prefix)));
  return keys.map((k) => String(k).slice(prefix.length)).sort();
}

export async function fileDeleteAll(projectId: string): Promise<void> {
  await run('files', 'readwrite', (s) => s.delete(rangeFor(`${projectId}/`)));
}

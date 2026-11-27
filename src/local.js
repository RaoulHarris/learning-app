// What the app keeps on this device: copies of the repo's files, the outbox
// of what this device has written and not yet pushed, and a few settings.
//
// Two implementations of one interface: IndexedDB in the browser, and a
// plain in-memory one for the tests.
//
//   files   path -> {path, sha, text}: the repo's files as last fetched (sha
//           is the git blob sha, so a file is fetched again only if it changed)
//   outbox  {id, path, mode, text}: what this device wrote, oldest first;
//           mode "append" adds text to the end of the file (a log), "put"
//           replaces it (a round's brief or questions), "weight" ({slug,
//           weight} instead of text) sets one subject's review weight in
//           subjects/reviews.json
//   kv      small values: the last sync, its result

const DB_NAME = 'learn';
const DB_VERSION = 1;

function promise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** The browser's store, in IndexedDB. */
export async function openLocal() {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
    if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
  };
  const db = await promise(open);
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    files: {
      get: (path) => promise(store('files').get(path)),
      all: () => promise(store('files').getAll()),
      async putMany(records) {
        const tx = db.transaction('files', 'readwrite');
        for (const r of records) tx.objectStore('files').put(r);
        await done(tx);
      },
      async deleteMany(paths) {
        const tx = db.transaction('files', 'readwrite');
        for (const p of paths) tx.objectStore('files').delete(p);
        await done(tx);
      },
      clear: () => promise(store('files', 'readwrite').clear()),
    },
    outbox: {
      add: (record) => promise(store('outbox', 'readwrite').add(record)),
      all: () => promise(store('outbox').getAll()),
      /** Push done: the files' new contents in, the records pushed out, at once. */
      async settle(ids, records) {
        const tx = db.transaction(['outbox', 'files'], 'readwrite');
        for (const id of ids) tx.objectStore('outbox').delete(id);
        for (const r of records) tx.objectStore('files').put(r);
        await done(tx);
      },
    },
    kv: {
      get: (key) => promise(store('kv').get(key)),
      set: (key, value) => promise(store('kv', 'readwrite').put(value, key)),
    },
  };
}

/** The same interface in memory, for tests. */
export function memoryLocal() {
  const files = new Map();
  const outbox = new Map();
  const kv = new Map();
  let next = 1;
  const copy = (x) => (x === undefined ? undefined : structuredClone(x));
  return {
    files: {
      get: async (path) => copy(files.get(path)),
      all: async () => [...files.values()].map(copy),
      putMany: async (records) => { for (const r of records) files.set(r.path, copy(r)); },
      deleteMany: async (paths) => { for (const p of paths) files.delete(p); },
      clear: async () => files.clear(),
    },
    outbox: {
      add: async (record) => { const id = next++; outbox.set(id, { ...copy(record), id }); return id; },
      all: async () => [...outbox.values()].map(copy),
      settle: async (ids, records) => {
        for (const id of ids) outbox.delete(id);
        for (const r of records) files.set(r.path, copy(r));
      },
    },
    kv: {
      get: async (key) => copy(kv.get(key)),
      set: async (key, value) => { kv.set(key, copy(value)); },
    },
  };
}

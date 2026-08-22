// Cache persistant des reponses Overpass (IndexedDB).
//
// C'est la reponse principale au probleme de quota : l'API Overpass publique est
// un service benevole limite par adresse IP, et jusqu'ici chaque rechargement
// redemandait exactement les memes donnees. Une zone deja visitee ne coute
// desormais plus rien — ni pour toi, ni pour eux.
//
// Tout echoue en silence : navigation privee, quota disque plein, IndexedDB
// desactive. Le cache est un confort, jamais une dependance.

const DB_NAME = 'terra-drive';
const STORE = 'overpass';
const VERSION = 1;
const TTL_MS = 21 * 24 * 3600 * 1000; // 3 semaines : OSM bouge, mais lentement

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('savedAt', 'savedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export const store = {
  hits: 0,
  misses: 0,

  async get(key) {
    const db = await open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = tx(db, 'readonly').get(key);
        req.onsuccess = () => {
          const row = req.result;
          if (!row) {
            this.misses++;
            return resolve(undefined);
          }
          if (Date.now() - row.savedAt > TTL_MS) {
            this.misses++;
            this.delete(key);
            return resolve(undefined);
          }
          this.hits++;
          resolve(row.value);
        };
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  },

  async set(key, value) {
    const db = await open();
    if (!db) return;
    try {
      tx(db, 'readwrite').put({ key, value, savedAt: Date.now() });
    } catch {
      /* quota atteint : on continue sans cache */
    }
  },

  async delete(key) {
    const db = await open();
    if (!db) return;
    try {
      tx(db, 'readwrite').delete(key);
    } catch {}
  },

  async count() {
    const db = await open();
    if (!db) return 0;
    return new Promise((resolve) => {
      try {
        const req = tx(db, 'readonly').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  },

  async clear() {
    const db = await open();
    if (!db) return;
    try {
      tx(db, 'readwrite').clear();
    } catch {}
  },
};

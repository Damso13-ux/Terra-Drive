// File de requetes prioritaire + retries. C'est la piece maitresse de la fiabilite :
// rien ne doit jamais rester "en attente pour toujours" sans que l'UI le sache.

export class RequestQueue {
  constructor({ concurrency = 8, retries = 3, baseDelay = 350 } = {}) {
    this.concurrency = concurrency;
    this.retries = retries;
    this.baseDelay = baseDelay;
    this.pending = new Map(); // key -> entry
    this.inflight = new Map(); // key -> promise
    this.active = 0;
    this.stats = { done: 0, failed: 0, retried: 0 };
    this.cancelled = new Set();
  }

  get queued() {
    return this.pending.size;
  }

  /**
   * @param key      identifiant unique (dedoublonnage)
   * @param priority plus petit = plus urgent
   * @param task     () => Promise<T>
   */
  add(key, priority, task) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending.set(key, { key, priority, task, resolve, reject, promise, attempt: 0 });
    this.inflight.set(key, promise);
    queueMicrotask(() => this._pump());
    return promise;
  }

  /** Reprioritise une requete deja en file (le joueur s'est rapproche). */
  reprioritise(key, priority) {
    const e = this.pending.get(key);
    if (e) e.priority = priority;
  }

  /** Annule ce qui n'a pas encore demarre (le joueur est parti trop loin). */
  drop(key) {
    const e = this.pending.get(key);
    if (!e) return;
    this.pending.delete(key);
    this.inflight.delete(key);
    e.reject(new DroppedError(key));
  }

  _pump() {
    while (this.active < this.concurrency && this.pending.size > 0) {
      let best = null;
      for (const e of this.pending.values()) {
        if (!best || e.priority < best.priority) best = e;
      }
      this.pending.delete(best.key);
      this.active++;
      this._run(best);
    }
  }

  async _run(entry) {
    try {
      const value = await entry.task();
      this.stats.done++;
      this.inflight.delete(entry.key);
      entry.resolve(value);
    } catch (err) {
      if (entry.attempt < this.retries) {
        entry.attempt++;
        this.stats.retried++;
        const delay = this.baseDelay * Math.pow(2, entry.attempt - 1) * (0.7 + Math.random() * 0.6);
        setTimeout(() => {
          this.pending.set(entry.key, entry);
          this._pump();
        }, delay);
      } else {
        this.stats.failed++;
        this.inflight.delete(entry.key);
        entry.reject(err);
      }
    } finally {
      this.active--;
      this._pump();
    }
  }
}

export class DroppedError extends Error {}

/** Charge une image cross-origin, avec timeout dur (sinon un socket mort bloque un slot). */
export function loadImage(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('timeout ' + url));
    }, timeout);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('http error ' + url));
    };
    img.src = url;
  });
}

/** fetch avec timeout via AbortController. */
export async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Cache LRU simple pour les tuiles decodees. */
export class LRU {
  constructor(limit = 512, onEvict = null) {
    this.limit = limit;
    this.map = new Map();
    this.onEvict = onEvict;
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  has(k) {
    return this.map.has(k);
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      const dead = this.map.get(oldest);
      this.map.delete(oldest);
      if (this.onEvict) this.onEvict(dead, oldest);
    }
  }
  get size() {
    return this.map.size;
  }
}

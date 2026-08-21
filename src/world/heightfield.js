// Modele d'altitude global, alimente par les tuiles "Terrarium" (Copernicus / IGN / CNIG).
// Deux niveaux : un niveau fin pour le relief sous les roues, un niveau grossier
// charge tres large en arriere-plan pour qu'une altitude soit TOUJOURS disponible,
// meme si une tuile fine manque ou tarde. Plus jamais de voiture qui tombe dans le vide.

import { loadImage, LRU } from '../core/net.js';
import { TILE_PX } from '../core/geo.js';

const HOSTS = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
  'https://elevation-tiles-prod.s3.amazonaws.com/terrarium',
];

const decodeCanvas = document.createElement('canvas');
decodeCanvas.width = TILE_PX;
decodeCanvas.height = TILE_PX;
const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

/** PNG terrarium -> Float32Array d'altitudes en metres. */
function decodeTerrarium(img) {
  decodeCtx.clearRect(0, 0, TILE_PX, TILE_PX);
  decodeCtx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
  const { data } = decodeCtx.getImageData(0, 0, TILE_PX, TILE_PX);
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return out;
}

class Level {
  constructor(zoom, limit) {
    this.zoom = zoom;
    this.tiles = new LRU(limit);
    this.failed = new Set();
  }
  key(tx, ty) {
    return tx + '/' + ty;
  }
  get(tx, ty) {
    return this.tiles.get(this.key(tx, ty));
  }
}

export class Heightfield {
  constructor(proj, queue, { fineZoom = 15, coarseZoom = 11 } = {}) {
    this.proj = proj;
    this.queue = queue;
    this.fine = new Level(fineZoom, 220);
    this.coarse = new Level(coarseZoom, 64);
    this.version = 0; // incremente a chaque tuile fine recue (invalidation fine)
    this.epoch = 0; // avance au plus une fois par seconde (reconstructions lourdes)
    this.lastQuality = 0;
    this.onTile = null;
    this._epochVersion = 0;
    this._epochTimer = 0;
  }

  get fineZoom() {
    return this.fine.zoom;
  }

  /**
   * A appeler une fois par image. Fait avancer `epoch` au plus une fois par seconde :
   * les reconstructions couteuses (rubans de route) s'y accrochent, pas a `version`.
   */
  tick(dt) {
    if (this.version === this._epochVersion) return;
    this._epochTimer += dt;
    if (this._epochTimer < 0.9) return;
    this._epochTimer = 0;
    this._epochVersion = this.version;
    this.epoch++;
  }

  /** Charge un carre de tuiles grossieres autour de l'origine : filet de securite. */
  async primeCoarse(radius = 1) {
    const { proj, coarse } = this;
    const cx = Math.floor(proj.worldToPixelX(0, coarse.zoom) / TILE_PX);
    const cy = Math.floor(proj.worldToPixelY(0, coarse.zoom) / TILE_PX);
    const jobs = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        jobs.push(this.request(coarse, cx + dx, cy + dy, -1000));
      }
    }
    await Promise.allSettled(jobs);
  }

  request(level, tx, ty, priority) {
    const key = level.key(tx, ty);
    if (level.tiles.has(key) || level.failed.has(key)) return Promise.resolve();
    const n = Math.pow(2, level.zoom);
    if (tx < 0 || ty < 0 || tx >= n || ty >= n) return Promise.resolve();

    let hostIndex = 0;
    const task = async () => {
      const host = HOSTS[hostIndex % HOSTS.length];
      hostIndex++;
      const img = await loadImage(`${host}/${level.zoom}/${tx}/${ty}.png`);
      return decodeTerrarium(img);
    };

    return this.queue
      .add('elev' + level.zoom + ':' + key, priority, task)
      .then((data) => {
        level.tiles.set(key, data);
        if (level === this.fine) {
          this.version++;
          if (this.onTile) this.onTile(tx, ty, level.zoom);
        }
      })
      .catch(() => {
        level.failed.add(key);
      });
  }

  requestFine(tx, ty, priority) {
    return this.request(this.fine, tx, ty, priority);
  }

  /** Lecture d'un texel global (coordonnees pixel entieres) sur un niveau. */
  texel(level, gx, gy) {
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    const tile = level.get(tx, ty);
    if (!tile) return null;
    const lx = gx - tx * TILE_PX;
    const ly = gy - ty * TILE_PX;
    return tile[ly * TILE_PX + lx];
  }

  /** Bilineaire sur un niveau, y compris a cheval sur plusieurs tuiles. */
  sampleLevel(level, worldX, worldZ) {
    const px = this.proj.worldToPixelX(worldX, level.zoom) - 0.5;
    const py = this.proj.worldToPixelY(worldZ, level.zoom) - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const h00 = this.texel(level, x0, y0);
    if (h00 === null) return null;
    const h10 = this.texel(level, x0 + 1, y0);
    const h01 = this.texel(level, x0, y0 + 1);
    const h11 = this.texel(level, x0 + 1, y0 + 1);
    if (h10 === null || h01 === null || h11 === null) return h00;
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fy;
  }

  /**
   * Altitude au sol. Retourne toujours un nombre.
   * `quality` : 2 = donnee fine, 1 = repli grossier, 0 = aucune donnee (0 m).
   */
  sample(worldX, worldZ) {
    const h = this.sampleLevel(this.fine, worldX, worldZ);
    if (h !== null) {
      this.lastQuality = 2;
      return h;
    }
    const c = this.sampleLevel(this.coarse, worldX, worldZ);
    if (c !== null) {
      this.lastQuality = 1;
      return c;
    }
    this.lastQuality = 0;
    return 0;
  }

  /** Normale du terrain par differences finies. */
  normal(worldX, worldZ, eps = 2, out = null) {
    const hL = this.sample(worldX - eps, worldZ);
    const hR = this.sample(worldX + eps, worldZ);
    const hD = this.sample(worldX, worldZ - eps);
    const hU = this.sample(worldX, worldZ + eps);
    const nx = (hL - hR) / (2 * eps);
    const nz = (hD - hU) / (2 * eps);
    const len = Math.hypot(nx, 1, nz);
    const n = out || { x: 0, y: 0, z: 0 };
    n.x = nx / len;
    n.y = 1 / len;
    n.z = nz / len;
    return n;
  }

  /** Vraie si le point est couvert par de la donnee fine. */
  hasFine(worldX, worldZ) {
    return this.sampleLevel(this.fine, worldX, worldZ) !== null;
  }
}

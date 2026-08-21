// Reseau routier issu d'OpenStreetMap (Overpass), streame par cellules de 1.2 km.
//
// Deux ameliorations clefs par rapport a un simple drapage de polylignes :
//  1. le profil altimetrique de chaque route est LISSE (le modele d'altitude a ~3 m/px
//     est bruite : conduire dessus brut donne une route en tole ondulee) ;
//  2. la chaussee devient une vraie surface de collision, avec un raccord progressif
//     vers le terrain sur les bas-cotes.

import { fetchWithTimeout } from '../core/net.js';

// ATTENTION : seuls les miroirs qui renvoient un en-tete Access-Control-Allow-Origin
// sont utilisables depuis un navigateur. kumi.systems et private.coffee repondent
// parfaitement a curl mais sont bloques par le CORS : les inclure ici transformait
// chaque nouvelle tentative en echec garanti.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const EXCLUDED =
  'footway|path|cycleway|steps|pedestrian|bridleway|corridor|platform|proposed|construction|raceway|escape';

// largeur (m), adherence relative, rang (0 = axe majeur)
const ROAD_CLASS = {
  motorway: { w: 15.0, grip: 1.0, rank: 0 },
  motorway_link: { w: 7.5, grip: 1.0, rank: 1 },
  trunk: { w: 12.0, grip: 1.0, rank: 1 },
  trunk_link: { w: 7.0, grip: 1.0, rank: 2 },
  primary: { w: 10.0, grip: 0.99, rank: 2 },
  primary_link: { w: 6.5, grip: 0.99, rank: 3 },
  secondary: { w: 8.5, grip: 0.98, rank: 3 },
  secondary_link: { w: 6.0, grip: 0.98, rank: 4 },
  tertiary: { w: 7.5, grip: 0.97, rank: 4 },
  tertiary_link: { w: 5.5, grip: 0.97, rank: 5 },
  unclassified: { w: 6.0, grip: 0.95, rank: 5 },
  residential: { w: 6.5, grip: 0.95, rank: 5 },
  living_street: { w: 5.5, grip: 0.94, rank: 6 },
  service: { w: 4.5, grip: 0.92, rank: 7 },
  track: { w: 3.5, grip: 0.72, rank: 8 },
};

const LOOSE_SURFACES = new Set([
  'gravel', 'dirt', 'ground', 'unpaved', 'sand', 'grass',
  'compacted', 'fine_gravel', 'earth', 'mud',
]);

const CELL = 1200; // taille d'une cellule de streaming, en metres
const STEP = 5; // pas de reechantillonnage le long d'une route, en metres
const SHOULDER = 1.6; // largeur du raccord chaussee -> terrain, en metres
const GRID = 48; // taille d'une cellule de la grille d'acceleration, en metres

export const ROAD_CELL = CELL;

export class RoadNetwork {
  constructor(proj, heightfield, queue) {
    this.proj = proj;
    this.hf = heightfield;
    this.queue = queue;
    this.cells = new Map(); // "cx,cz" -> 'loading' | 'ready' | 'failed'
    this.ways = new Map(); // osm id -> way
    this.grid = new Map(); // "gx,gz" -> [way, segIndex, way, segIndex, ...]
    this.wayCells = new Map(); // "cx,cz" -> [way, ...] pour le regroupement du rendu
    this.dirty = false;
    this.onChange = null;
    this.stats = { ways: 0, cells: 0, failed: 0, loading: 0 };
  }

  cellKey(cx, cz) {
    return cx + ',' + cz;
  }

  /** Demande le chargement des cellules couvrant un disque autour du joueur. */
  ensureArea(worldX, worldZ, radius) {
    const c0x = Math.floor((worldX - radius) / CELL);
    const c1x = Math.floor((worldX + radius) / CELL);
    const c0z = Math.floor((worldZ - radius) / CELL);
    const c1z = Math.floor((worldZ + radius) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = this.cellKey(cx, cz);
        if (this.cells.has(key)) continue;
        this.cells.set(key, 'loading');
        this.stats.loading++;
        const dist = Math.hypot((cx + 0.5) * CELL - worldX, (cz + 0.5) * CELL - worldZ);
        this._fetchCell(cx, cz, key, dist);
      }
    }
  }

  _fetchCell(cx, cz, key, priority) {
    const m = 40; // marge : evite les routes coupees net a la frontiere de cellule
    const sw = this.proj.toLonLat(cx * CELL - m, (cz + 1) * CELL + m);
    const ne = this.proj.toLonLat((cx + 1) * CELL + m, cz * CELL - m);
    const bbox = sw.lat + ',' + sw.lon + ',' + ne.lat + ',' + ne.lon;
    const query =
      '[out:json][timeout:40];way["highway"]["highway"!~"' + EXCLUDED + '"]' +
      '["area"!="yes"](' + bbox + ');out geom;';

    let attempt = 0;
    const task = async () => {
      const url = MIRRORS[attempt % MIRRORS.length];
      attempt++;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        },
        45000
      );
      return res.json();
    };

    this.queue
      .add('roads:' + key, priority, task)
      .then((json) => {
        this.cells.set(key, 'ready');
        this.stats.cells++;
        this.stats.loading--;
        this._ingest(json.elements || []);
      })
      .catch(() => {
        this.cells.set(key, 'failed');
        this.stats.failed++;
        this.stats.loading--;
        // Nouvelle tentative differee : une cellule ratee n'est pas perdue definitivement.
        setTimeout(() => {
          if (this.cells.get(key) === 'failed') this.cells.delete(key);
        }, 20000);
      });
  }

  _ingest(elements) {
    let added = 0;
    for (const el of elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      if (this.ways.has(el.id)) continue;
      const way = this._buildWay(el);
      if (!way) continue;
      this.ways.set(el.id, way);
      this._index(way);
      const ck = Math.floor(way.pts[0] / CELL) + ',' + Math.floor(way.pts[1] / CELL);
      let bucket = this.wayCells.get(ck);
      if (!bucket) this.wayCells.set(ck, (bucket = []));
      bucket.push(way);
      way.cell = ck;
      added++;
    }
    if (added) {
      this.stats.ways = this.ways.size;
      this.dirty = true;
      if (this.onChange) this.onChange();
    }
  }

  _buildWay(el) {
    const tags = el.tags || {};
    const cls = ROAD_CLASS[tags.highway];
    if (!cls) return null;

    let width = cls.w;
    const lanes = parseInt(tags.lanes, 10);
    if (Number.isFinite(lanes) && lanes > 0) width = Math.max(cls.w * 0.6, lanes * 3.3);
    if (tags.width) {
      const w = parseFloat(tags.width);
      if (Number.isFinite(w) && w > 1.5 && w < 40) width = w;
    }
    if (tags.oneway === 'yes' && !tags.lanes) width *= 0.62;

    let grip = cls.grip;
    if (tags.surface && LOOSE_SURFACES.has(tags.surface)) grip = Math.min(grip, 0.7);

    const raw = [];
    const tmp = [0, 0];
    for (const g of el.geometry) {
      this.proj.toWorld(g.lon, g.lat, tmp);
      raw.push(tmp[0], tmp[1]);
    }
    const pts = resample(raw, STEP);
    if (pts.length < 4) return null;

    return {
      id: el.id,
      name: tags.name || null,
      highway: tags.highway,
      rank: cls.rank,
      bridge: !!tags.bridge && tags.bridge !== 'no',
      tunnel: !!tags.tunnel && tags.tunnel !== 'no',
      halfWidth: width / 2,
      grip,
      pts, // [x0,z0, x1,z1, ...]
      y: new Float32Array(pts.length / 2),
      elevVersion: -1,
      bbox: bboxOf(pts),
    };
  }

  _index(way) {
    const n = way.pts.length / 2;
    const pad = way.halfWidth + SHOULDER;
    for (let i = 0; i < n - 1; i++) {
      const x1 = way.pts[i * 2], z1 = way.pts[i * 2 + 1];
      const x2 = way.pts[i * 2 + 2], z2 = way.pts[i * 2 + 3];
      const gx0 = Math.floor((Math.min(x1, x2) - pad) / GRID);
      const gx1 = Math.floor((Math.max(x1, x2) + pad) / GRID);
      const gz0 = Math.floor((Math.min(z1, z2) - pad) / GRID);
      const gz1 = Math.floor((Math.max(z1, z2) + pad) / GRID);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = gx + ',' + gz;
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(way, i);
        }
      }
    }
  }

  /**
   * Calcule (ou recalcule) le profil altimetrique lisse d'une route.
   * Le lissage est contraint : on ne s'ecarte jamais de plus de `maxDev` du terrain,
   * sinon les routes de montagne se mettent a flotter au-dessus des vallees.
   */
  updateProfile(way, force = false) {
    if (!force && way.elevVersion === this.hf.version) return;
    way.elevVersion = this.hf.version;
    const n = way.y.length;
    const base = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      base[i] = this.hf.sample(way.pts[i * 2], way.pts[i * 2 + 1]);
    }
    const y = way.y;
    y.set(base);
    const passes = way.bridge ? 26 : 12;
    const maxDev = way.bridge ? 12 : 2.2;
    for (let p = 0; p < passes; p++) {
      let prev = y[0];
      for (let i = 1; i < n - 1; i++) {
        const cur = y[i];
        let v = cur + ((prev + y[i + 1]) * 0.5 - cur) * 0.55;
        const d = v - base[i];
        if (d > maxDev) v = base[i] + maxDev;
        else if (d < -maxDev) v = base[i] - maxDev;
        prev = cur;
        y[i] = v;
      }
    }
  }

  /** Rafraichit tous les profils si le modele d'altitude a progresse. */
  refreshProfiles() {
    let changed = false;
    for (const way of this.ways.values()) {
      if (way.elevVersion !== this.hf.version) {
        this.updateProfile(way);
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /**
   * Interrogation du sol. Retourne null hors chaussee, sinon
   * { y, grip, blend } ou blend vaut 1 au centre et 0 au bord du bas-cote.
   */
  queryGround(x, z, extra = 0, falloff = SHOULDER) {
    const gx = Math.floor(x / GRID);
    const gz = Math.floor(z / GRID);
    let best = null;
    let bestScore = Infinity;
    // Un corridor elargi peut deborder sur les cellules voisines.
    const span = extra + falloff > 0 ? Math.ceil((extra + falloff) / GRID) : 0;
    for (let cz = gz - span; cz <= gz + span; cz++) {
    for (let cx = gx - span; cx <= gx + span; cx++) {
    const list = this.grid.get(cx + ',' + cz);
    if (!list) continue;
    for (let k = 0; k < list.length; k += 2) {
      const way = list[k];
      const i = list[k + 1];
      const x1 = way.pts[i * 2], z1 = way.pts[i * 2 + 1];
      const x2 = way.pts[i * 2 + 2], z2 = way.pts[i * 2 + 3];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      let t = ((x - x1) * dx + (z - z1) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x1 + dx * t, pz = z1 + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      const inner = way.halfWidth + extra;
      if (dist > inner + falloff) continue;
      // A distance egale on prefere l'axe de rang le plus eleve : une nationale
      // l'emporte sur la voie de service qui la longe.
      const score = dist - (8 - way.rank) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        this.updateProfile(way);
        const y = way.y[i] + (way.y[i + 1] - way.y[i]) * t;
        const raw = dist <= inner ? 1 : 1 - (dist - inner) / falloff;
        best = { y, grip: way.grip, blend: raw * raw * (3 - 2 * raw), way };
      }
    }
    }
    }
    return best;
  }

  /** Point de route le plus proche : sert a poser la voiture au spawn. */
  nearestRoad(x, z, maxRadius = 300) {
    let best = null;
    let bestDist = Infinity;
    const maxCells = Math.ceil(maxRadius / GRID);
    for (let ring = 0; ring <= maxCells; ring++) {
      const gx0 = Math.floor(x / GRID) - ring;
      const gx1 = Math.floor(x / GRID) + ring;
      const gz0 = Math.floor(z / GRID) - ring;
      const gz1 = Math.floor(z / GRID) + ring;
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          // anneau uniquement (l'interieur a deja ete visite)
          if (ring > 0 && gx !== gx0 && gx !== gx1 && gz !== gz0 && gz !== gz1) continue;
          const list = this.grid.get(gx + ',' + gz);
          if (!list) continue;
          for (let k = 0; k < list.length; k += 2) {
            const way = list[k], i = list[k + 1];
            const x1 = way.pts[i * 2], z1 = way.pts[i * 2 + 1];
            const x2 = way.pts[i * 2 + 2], z2 = way.pts[i * 2 + 3];
            const dx = x2 - x1, dz = z2 - z1;
            const len2 = dx * dx + dz * dz;
            if (len2 < 1e-6) continue;
            let t = ((x - x1) * dx + (z - z1) * dz) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = x1 + dx * t, pz = z1 + dz * t;
            const d = Math.hypot(x - px, z - pz) + way.rank * 2.0;
            if (d < bestDist) {
              bestDist = d;
              this.updateProfile(way);
              best = {
                x: px,
                z: pz,
                y: way.y[i] + (way.y[i + 1] - way.y[i]) * t,
                heading: Math.atan2(-dx, -dz),
                way,
              };
            }
          }
        }
      }
      if (best && ring > 0) break; // un anneau de marge pour ne pas rater plus proche
    }
    return best;
  }

  /** Routes intersectant une zone, triees pour un rendu stable. */
  waysInBox(minX, minZ, maxX, maxZ) {
    const out = [];
    for (const way of this.ways.values()) {
      const b = way.bbox;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      out.push(way);
    }
    out.sort((a, b) => b.rank - a.rank || a.id - b.id);
    return out;
  }
}

/** Reechantillonne une polyligne plate a pas constant. */
function resample(flat, step) {
  const out = [flat[0], flat[1]];
  let carry = 0;
  for (let i = 0; i < flat.length - 2; i += 2) {
    const x1 = flat[i], z1 = flat[i + 1];
    const x2 = flat[i + 2], z2 = flat[i + 3];
    const seg = Math.hypot(x2 - x1, z2 - z1);
    if (seg < 1e-6) continue;
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t);
      d += step;
    }
    carry = (carry + seg) % step;
  }
  const n = out.length;
  const lastX = flat[flat.length - 2], lastZ = flat[flat.length - 1];
  if (Math.hypot(out[n - 2] - lastX, out[n - 1] - lastZ) > step * 0.25) out.push(lastX, lastZ);
  return out;
}

function bboxOf(pts) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

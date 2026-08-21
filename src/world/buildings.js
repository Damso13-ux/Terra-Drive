// Batiments OpenStreetMap extrudes.
//
// C'est le poste qui change le plus l'image : sans volume, une ville vue de la
// route n'est qu'une photo aerienne etalee sur des bosses. Avec, on retrouve des
// facades, des occultations, une echelle.
//
// Les emprises sont chargees par cellules, comme les routes, mais toujours en
// priorite basse : mieux vaut une route sans batiments qu'un decor sans route.

import * as THREE from 'three';
import { fetchWithTimeout } from '../core/net.js';
import { ROAD_CELL } from './roads.js';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const LEVEL_HEIGHT = 3.1; // hauteur d'un etage, en metres
const DEFAULT_LEVELS = 2;
const MAX_PER_CELL = 1400; // au-dela, une cellule dense coute plus qu'elle n'apporte
const MIN_AREA = 12; // m2 : sous ce seuil c'est un abri de jardin, on passe

// Teintes de facade, tirees au sort de facon deterministe par batiment.
// Teintes volontairement sombres : l'eclairage indirect est fort (surtout sans
// carte d'environnement), et des facades claires ressortent completement brulees.
const WALL_TINTS = [
  [0.40, 0.37, 0.33], [0.35, 0.33, 0.30], [0.44, 0.41, 0.35],
  [0.31, 0.30, 0.28], [0.42, 0.38, 0.32], [0.37, 0.36, 0.35],
];
const ROOF_TINTS = [
  [0.26, 0.16, 0.13], [0.22, 0.15, 0.12], [0.19, 0.19, 0.21],
  [0.29, 0.18, 0.13], [0.17, 0.17, 0.19],
];

export class Buildings {
  constructor({ scene, proj, ground, queue, radius = 1 }) {
    this.proj = proj;
    this.ground = ground;
    this.queue = queue;
    this.radius = radius;
    this.enabled = true;

    this.group = new THREE.Group();
    this.group.name = 'buildings';
    scene.add(this.group);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
      // Les batiments sont des volumes fermes : le double face coute presque
      // rien et supprime tout risque d'emprise orientee a l'envers.
      side: THREE.DoubleSide,
    });

    this.cells = new Map(); // "cx,cz" -> 'loading' | 'ready' | 'failed'
    this.shapes = new Map(); // "cx,cz" -> [shape]
    this.meshes = new Map(); // "cx,cz" -> Mesh
    this.stats = { cells: 0, count: 0, failed: 0 };
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
  }

  /** Charge les emprises autour du joueur. */
  ensureArea(worldX, worldZ) {
    if (!this.enabled) return;
    const cx = Math.floor(worldX / ROAD_CELL);
    const cz = Math.floor(worldZ / ROAD_CELL);
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const key = cx + dx + ',' + (cz + dz);
        if (this.cells.has(key)) continue;
        this.cells.set(key, 'loading');
        this._fetchCell(cx + dx, cz + dz, key);
      }
    }
  }

  _fetchCell(cx, cz, key) {
    const m = 30;
    const sw = this.proj.toLonLat(cx * ROAD_CELL - m, (cz + 1) * ROAD_CELL + m);
    const ne = this.proj.toLonLat((cx + 1) * ROAD_CELL + m, cz * ROAD_CELL - m);
    const bbox = sw.lat + ',' + sw.lon + ',' + ne.lat + ',' + ne.lon;
    const query = '[out:json][timeout:50];way["building"](' + bbox + ');out geom;';

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
        55000
      );
      const json = await res.json();
      if (json.remark && !(json.elements || []).length) throw new Error(json.remark);
      return json;
    };

    // priorite volontairement mauvaise : les routes passent toujours devant
    this.queue
      .add('build:' + key, 5000, task)
      .then((json) => {
        this.cells.set(key, 'ready');
        this.stats.cells++;
        this.shapes.set(key, this._parse(json.elements || []));
        this.stats.count += this.shapes.get(key).length;
      })
      .catch(() => {
        this.cells.set(key, 'failed');
        this.stats.failed++;
      });
  }

  _parse(elements) {
    const out = [];
    const tmp = [0, 0];
    for (const el of elements) {
      if (out.length >= MAX_PER_CELL) break;
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;

      const pts = [];
      for (const g of el.geometry) {
        this.proj.toWorld(g.lon, g.lat, tmp);
        pts.push(new THREE.Vector2(tmp[0], tmp[1]));
      }
      // OSM ferme ses polygones en repetant le premier point
      if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 0.2) pts.pop();
      if (pts.length < 3) continue;

      const signed = THREE.ShapeUtils.area(pts);
      if (Math.abs(signed) < MIN_AREA) continue;
      if (signed < 0) pts.reverse(); // orientation uniforme pour tous les batiments

      out.push({ id: el.id, pts, height: heightOf(el.tags || {}) });
    }
    return out;
  }

  /** Construit et libere les maillages selon la position du joueur. */
  update(worldX, worldZ) {
    if (!this.enabled) return;
    const cx = Math.floor(worldX / ROAD_CELL);
    const cz = Math.floor(worldZ / ROAD_CELL);
    const wanted = new Set();

    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const key = cx + dx + ',' + (cz + dz);
        const shapes = this.shapes.get(key);
        if (!shapes || !shapes.length) continue;
        wanted.add(key);
        if (!this.meshes.has(key)) this._build(key, shapes);
      }
    }

    for (const [key, mesh] of this.meshes) {
      if (wanted.has(key)) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(key);
    }
  }

  _build(key, shapes) {
    const positions = [];
    const normals = [];
    const colors = [];

    for (const b of shapes) {
      addBuilding(b, this.ground, positions, normals, colors);
    }
    if (!positions.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this.meshes.set(key, mesh);
  }
}

/** Hauteur en metres depuis les tags OSM, avec des replis raisonnables. */
function heightOf(tags) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 1.5 && h < 400) return h;
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0 && levels < 120) return levels * LEVEL_HEIGHT;
  if (tags.building === 'church' || tags.building === 'cathedral') return 18;
  if (tags.building === 'industrial' || tags.building === 'warehouse') return 9;
  if (tags.building === 'garage' || tags.building === 'shed' || tags.building === 'hut') return 2.8;
  return DEFAULT_LEVELS * LEVEL_HEIGHT;
}

/** Entier pseudo-aleatoire stable : le meme batiment garde sa teinte. */
function hash(id) {
  let x = (id ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function addBuilding(b, ground, positions, normals, colors) {
  const { pts, height, id } = b;
  const n = pts.length;

  // Assise : le point le plus bas de l'emprise, pour qu'un batiment en pente
  // s'enfonce dans le terrain plutot que de flotter sur ses fondations.
  // Huit sondes reparties suffisent : interroger chaque sommet coutait une
  // seconde entiere sur une cellule de centre-ville.
  let base = Infinity;
  const step = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n; i += step) {
    const h = ground.height(pts[i].x, pts[i].y);
    if (h < base) base = h;
  }
  if (!Number.isFinite(base)) return;
  base -= 0.6;
  const top = base + height;

  // Decalages NON SIGNES : hash() rend un entier sur 32 bits non signe, et `>>`
  // le rendrait negatif au-dela de 2^31, donc un index de teinte negatif.
  const r = hash(id);
  const wall = WALL_TINTS[r % WALL_TINTS.length];
  const roof = ROOF_TINTS[(r >>> 8) % ROOF_TINTS.length];
  // legere variation par batiment, pour casser l'uniformite
  const shade = 0.88 + ((r >>> 16) % 100) / 400;

  // --- murs ---------------------------------------------------------------
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % n];
    const dx = c.x - a.x;
    const dz = c.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = dz / len;
    const nz = -dx / len;

    // deux triangles par pan de mur
    pushVertex(positions, a.x, base, a.y);
    pushVertex(positions, c.x, base, c.y);
    pushVertex(positions, c.x, top, c.y);
    pushVertex(positions, a.x, base, a.y);
    pushVertex(positions, c.x, top, c.y);
    pushVertex(positions, a.x, top, a.y);
    for (let k = 0; k < 6; k++) {
      pushVertex(normals, nx, 0, nz);
      // un mur legerement plus sombre en bas donne du relief sans texture
      const f = k === 2 || k === 4 || k === 5 ? 1 : 0.82;
      pushVertex(colors, wall[0] * shade * f, wall[1] * shade * f, wall[2] * shade * f);
    }
  }

  // --- toiture ------------------------------------------------------------
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts, []);
  } catch {
    return; // emprise degeneree : les murs suffisent
  }
  for (const f of faces) {
    for (const idx of f) {
      const p = pts[idx];
      pushVertex(positions, p.x, top, p.y);
      pushVertex(normals, 0, 1, 0);
      pushVertex(colors, roof[0] * shade, roof[1] * shade, roof[2] * shade);
    }
  }
}

function pushVertex(arr, a, b, c) {
  arr.push(a, b, c);
}

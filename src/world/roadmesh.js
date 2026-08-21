// Rendu des chaussees : rubans drapes sur le profil lisse, fusionnes par cellule de
// streaming pour garder le nombre d'appels de dessin tres bas.

import * as THREE from 'three';
import { ROAD_CELL } from './roads.js';

const LIFT = 0.07; // hauteur du ruban au-dessus du profil, en metres
const TEX_LENGTH = 14; // longueur couverte par une repetition de la texture, en metres

function asphaltTexture({ marked }) {
  const W = 128, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = marked ? '#3a3a3d' : '#4a453c';
  ctx.fillRect(0, 0, W, H);

  // grain
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  if (marked) {
    ctx.fillStyle = 'rgba(232,232,225,0.72)';
    ctx.fillRect(Math.round(W * 0.055), 0, 3, H); // rive gauche
    ctx.fillRect(Math.round(W * 0.945) - 3, 0, 3, H); // rive droite
    // axe discontinu
    ctx.fillStyle = 'rgba(240,240,232,0.85)';
    const cx = Math.round(W / 2) - 2;
    for (let y = 0; y < H; y += 96) ctx.fillRect(cx, y, 4, 56);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class RoadMesh {
  constructor({ scene, roads, radius = 3 }) {
    this.roads = roads;
    this.radius = radius;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    scene.add(this.group);

    const common = {
      roughness: 0.88,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    };
    this.materials = {
      marked: new THREE.MeshStandardMaterial({ map: asphaltTexture({ marked: true }), ...common }),
      plain: new THREE.MeshStandardMaterial({ map: asphaltTexture({ marked: false }), ...common }),
    };

    this.cells = new Map(); // cellKey -> { meshes:{marked,plain}, signature }
    this.stats = { cells: 0, tris: 0 };
  }

  update(playerX, playerZ) {
    const cx = Math.floor(playerX / ROAD_CELL);
    const cz = Math.floor(playerZ / ROAD_CELL);
    const r = this.radius;
    const wanted = new Set();
    let tris = 0;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const key = cx + dx + ',' + (cz + dz);
        const ways = this.roads.wayCells.get(key);
        if (!ways || !ways.length) continue;
        wanted.add(key);
        const signature = ways.length + ':' + this.roads.hf.epoch;
        let entry = this.cells.get(key);
        if (!entry) {
          entry = { meshes: {}, signature: null };
          this.cells.set(key, entry);
        }
        if (entry.signature !== signature) {
          entry.signature = signature;
          this._build(entry, ways);
        }
        for (const m of Object.values(entry.meshes)) {
          if (m) tris += m.geometry.index.count / 3;
        }
      }
    }

    for (const [key, entry] of this.cells) {
      if (!wanted.has(key)) {
        this._dispose(entry);
        this.cells.delete(key);
      }
    }
    this.stats.cells = this.cells.size;
    this.stats.tris = tris;
  }

  _build(entry, ways) {
    const groups = { marked: [], plain: [] };
    for (const way of ways) {
      this.roads.updateProfile(way);
      groups[way.rank <= 6 ? 'marked' : 'plain'].push(way);
    }
    for (const kind of ['marked', 'plain']) {
      const list = groups[kind];
      const old = entry.meshes[kind];
      if (!list.length) {
        if (old) {
          this.group.remove(old);
          old.geometry.dispose();
          entry.meshes[kind] = null;
        }
        continue;
      }
      const geo = buildRibbons(list);
      if (old) {
        old.geometry.dispose();
        old.geometry = geo;
      } else {
        const mesh = new THREE.Mesh(geo, this.materials[kind]);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        entry.meshes[kind] = mesh;
      }
    }
  }

  _dispose(entry) {
    for (const kind of Object.keys(entry.meshes)) {
      const m = entry.meshes[kind];
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    entry.meshes = {};
  }
}

/** Fusionne une liste de routes en une seule geometrie de rubans. */
function buildRibbons(ways) {
  let vertexCount = 0;
  for (const w of ways) vertexCount += (w.y.length) * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  let v = 0;

  for (const way of ways) {
    const n = way.y.length;
    const hw = way.halfWidth;
    const start = v;
    let dist = 0;

    for (let i = 0; i < n; i++) {
      const x = way.pts[i * 2], z = way.pts[i * 2 + 1];
      // tangente par difference centree
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      let tx = way.pts[i1 * 2] - way.pts[i0 * 2];
      let tz = way.pts[i1 * 2 + 1] - way.pts[i0 * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // perpendiculaire horizontale
      const px = tz, pz = -tx;

      if (i > 0) {
        dist += Math.hypot(x - way.pts[(i - 1) * 2], z - way.pts[(i - 1) * 2 + 1]);
      }
      const y = way.y[i] + LIFT;
      const uv = dist / TEX_LENGTH;

      positions[v * 3] = x + px * hw;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z + pz * hw;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = 0;
      uvs[v * 2 + 1] = uv;
      v++;

      positions[v * 3] = x - px * hw;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z - pz * hw;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = 1;
      uvs[v * 2 + 1] = uv;
      v++;
    }

    for (let i = 0; i < n - 1; i++) {
      const a = start + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

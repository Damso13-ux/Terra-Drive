// Rendu des chaussees : rubans drapes sur le profil lisse, fusionnes par cellule de
// streaming pour garder le nombre d'appels de dessin tres bas.

import * as THREE from 'three';
import { cellsAround } from './cells.js';

const LIFT = 0.07; // hauteur du ruban au-dessus du profil, en metres
const TEX_LENGTH = 14; // longueur couverte par une repetition de la texture, en metres

/**
 * Revetement procedural, une texture par famille de route.
 *
 * L'axe U traverse la chaussee, l'axe V la parcourt : le marquage se dessine
 * donc en colonnes, et la texture se repete dans le sens de la marche.
 */
const FAMILIES = {
  autoroute: {
    base: '#32333a',
    grain: 22,
    edges: { at: 0.045, width: 4, alpha: 0.8 },
    lanes: [0.34, 0.66], // separateurs de voies, discontinus
    centre: null,
    ruts: null,
  },
  principale: {
    base: '#3a3a3d',
    grain: 26,
    edges: { at: 0.06, width: 3, alpha: 0.72 },
    lanes: null,
    centre: { dash: 56, gap: 40, width: 4, alpha: 0.85 },
    ruts: null,
  },
  secondaire: {
    base: '#403f41',
    grain: 30,
    edges: { at: 0.075, width: 2, alpha: 0.42 },
    lanes: null,
    centre: { dash: 30, gap: 76, width: 3, alpha: 0.5 },
    ruts: null,
  },
  piste: {
    base: '#2e2f34',
    grain: 18,
    edges: { at: 0.035, width: 6, alpha: 0.95 },
    lanes: null,
    centre: null,
    ruts: null,
  },
  terre: {
    base: '#5b4a35',
    grain: 44,
    edges: null,
    lanes: null,
    centre: null,
    ruts: [0.3, 0.7], // deux ornieres creusees par le passage
  },
};

function roadTexture(family) {
  const spec = FAMILIES[family] || FAMILIES.secondaire;
  const W = 128;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = spec.base;
  ctx.fillRect(0, 0, W, H);

  // ornieres : deux bandes assombries dans le sens de la marche
  if (spec.ruts) {
    for (const u of spec.ruts) {
      const g = ctx.createLinearGradient((u - 0.11) * W, 0, (u + 0.11) * W, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect((u - 0.11) * W, 0, 0.22 * W, H);
    }
  }

  // grain
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * spec.grain;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // rives
  if (spec.edges) {
    ctx.fillStyle = `rgba(233,233,226,${spec.edges.alpha})`;
    ctx.fillRect(Math.round(spec.edges.at * W), 0, spec.edges.width, H);
    ctx.fillRect(Math.round((1 - spec.edges.at) * W) - spec.edges.width, 0, spec.edges.width, H);
  }

  // axe discontinu
  if (spec.centre) {
    ctx.fillStyle = `rgba(240,240,232,${spec.centre.alpha})`;
    const x = Math.round(W / 2 - spec.centre.width / 2);
    const period = spec.centre.dash + spec.centre.gap;
    for (let y = 0; y < H; y += period) ctx.fillRect(x, y, spec.centre.width, spec.centre.dash);
  }

  // separateurs de voies
  if (spec.lanes) {
    ctx.fillStyle = 'rgba(236,236,228,0.62)';
    for (const u of spec.lanes) {
      const x = Math.round(u * W) - 1;
      for (let y = 0; y < H; y += 96) ctx.fillRect(x, y, 3, 40);
    }
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
    this.materials = {};
    for (const family of Object.keys(FAMILIES)) {
      this.materials[family] = new THREE.MeshStandardMaterial({
        map: roadTexture(family),
        ...common,
        // la terre est mate, le bitume neuf accroche un peu la lumiere
        roughness: family === 'terre' ? 0.98 : 0.86,
      });
    }

    this.cells = new Map(); // cellKey -> { meshes:{marked,plain}, signature }
    this.stats = { cells: 0, tris: 0 };
  }

  update(playerX, playerZ) {
    const wanted = new Set();
    let tris = 0;

    for (const cell of cellsAround(this.roads.proj, playerX, playerZ, this.radius)) {
      const ways = this.roads.wayCells.get(cell.key);
      if (!ways || !ways.length) continue;
      wanted.add(cell.key);
      const signature = ways.length + ':' + this.roads.hf.epoch;
      let entry = this.cells.get(cell.key);
      if (!entry) {
        entry = { meshes: {}, signature: null };
        this.cells.set(cell.key, entry);
      }
      if (entry.signature !== signature) {
        entry.signature = signature;
        this._build(entry, ways);
      }
      for (const m of Object.values(entry.meshes)) {
        if (m) tris += m.geometry.index.count / 3;
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
    const groups = {};
    for (const family of Object.keys(FAMILIES)) groups[family] = [];
    for (const way of ways) {
      this.roads.updateProfile(way);
      (groups[way.family] || groups.secondaire).push(way);
    }
    for (const kind of Object.keys(FAMILIES)) {
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

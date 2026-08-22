// Vegetation : arbres semes dans les zones boisees d'OpenStreetMap.
//
// Le semis est PSEUDO-ALEATOIRE MAIS DETERMINISTE : un arbre pousse toujours au
// meme endroit, quel que soit l'ordre de chargement ou le nombre de visites.
// Sans cela, la foret se redessinerait a chaque passage.
//
// Tout passe par des maillages instancies : un seul appel de dessin pour des
// milliers d'arbres. C'est la seule facon d'en mettre assez pour que ca compte.

import * as THREE from 'three';
import { cellsAround } from './cells.js';

// Ce qui merite un arbre, et a quelle densite (arbres pour 100 m x 100 m).
const WOODED = {
  forest: 26,
  wood: 26,
  orchard: 14,
  scrub: 9,
  heath: 3,
  park: 5,
  cemetery: 3,
  garden: 2,
};

const MIN_AREA = 400; // m2 : en dessous, un bosquet ne se voit pas
const TRUNK = 0x4a3b2c;

export class Vegetation {
  constructor({ scene, proj, ground, radius = 1, maxPerCell = 2500, enabled = true }) {
    this.proj = proj;
    this.ground = ground;
    this.radius = radius;
    this.maxPerCell = maxPerCell;
    this.enabled = enabled;

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);

    this.geometry = buildTreeGeometry();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });

    this.cells = new Map(); // cle -> [{x, z, scale, rotation, tint}]
    this.meshes = new Map();
    this.stats = { cells: 0, trees: 0 };
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
  }

  /** Oublie tout : appele avant un rejeu, quand les densites ont change. */
  reset() {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes.clear();
    this.cells.clear();
    this.stats = { cells: 0, trees: 0 };
  }

  /** Recoit les surfaces boisees d'une cellule, extraites de la meme requete. */
  ingest(cell, elements) {
    if (this.cells.has(cell.key)) return;
    const trees = [];
    const tmp = [0, 0];

    for (const el of elements) {
      if (trees.length >= this.maxPerCell) break;
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
      const tags = el.tags || {};
      const kind = tags.landuse || tags.natural || tags.leisure;
      const density = WOODED[kind];
      if (!density) continue;

      const pts = [];
      for (const g of el.geometry) {
        this.proj.toWorld(g.lon, g.lat, tmp);
        pts.push(new THREE.Vector2(tmp[0], tmp[1]));
      }
      if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 0.2) pts.pop();
      if (pts.length < 3) continue;

      const area = Math.abs(THREE.ShapeUtils.area(pts));
      if (area < MIN_AREA) continue;

      scatter(el.id, pts, area, density, trees, this.maxPerCell);
    }

    this.cells.set(cell.key, trees);
    this.stats.cells++;
    this.stats.trees += trees.length;
  }

  update(worldX, worldZ) {
    if (!this.enabled) return;
    const wanted = new Set();

    for (const cell of cellsAround(this.proj, worldX, worldZ, this.radius)) {
      const trees = this.cells.get(cell.key);
      if (!trees || !trees.length) continue;
      wanted.add(cell.key);
      if (!this.meshes.has(cell.key)) this._build(cell.key, trees);
    }

    for (const [key, mesh] of this.meshes) {
      if (wanted.has(key)) continue;
      this.group.remove(mesh);
      mesh.dispose();
      this.meshes.delete(key);
    }
  }

  _build(key, trees) {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, trees.length);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      pos.set(t.x, this.ground.height(t.x, t.z) - 0.3, t.z);
      q.setFromAxisAngle(up, t.rotation);
      scl.set(t.scale * t.width, t.scale, t.scale * t.width);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();

    this.group.add(mesh);
    this.meshes.set(key, mesh);
  }
}

/**
 * Seme des arbres dans un polygone.
 *
 * Tirage par rejet dans la boite englobante : simple, et la densite reste juste
 * puisqu'on ne compte que les points retenus. Le generateur est amorce par
 * l'identifiant OSM, donc la meme foret repousse toujours a l'identique.
 */
function scatter(id, pts, area, density, out, cap) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y;
    if (p.y > maxZ) maxZ = p.y;
  }
  const target = Math.min(1200, Math.round((area / 10000) * density));
  if (target < 1) return;

  const rand = mulberry(id >>> 0);
  const boxArea = (maxX - minX) * (maxZ - minZ);
  // On tire dans la boite englobante, donc une partie des tirages tombe hors du
  // polygone : d'ou le rapport des aires. Mais on s'arrete des que la cible est
  // atteinte, sinon une emprise rectangulaire — ou aucun tirage n'est rejete —
  // se retrouve avec bien plus d'arbres que la densite demandee.
  const attempts = Math.min(12000, Math.ceil(target * (boxArea / area)) + 12);
  let placed = 0;

  for (let i = 0; i < attempts && placed < target && out.length < cap; i++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (!inside(pts, x, z)) continue;
    placed++;
    out.push({
      x,
      z,
      scale: 4.5 + rand() * 5.5,
      width: 0.72 + rand() * 0.5,
      rotation: rand() * Math.PI * 2,
    });
  }
}

function inside(pts, x, z) {
  let yes = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[i].x, az = pts[i].y;
    const bx = pts[j].x, bz = pts[j].y;
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) yes = !yes;
  }
  return yes;
}

/** Generateur amorcable, pour que la meme foret repousse toujours a l'identique. */
function mulberry(seed) {
  let a = seed + 0x6d2b79f5;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Arbre generique : un tronc et deux cones de feuillage decales.
 *
 * Volontairement grossier — a la vitesse ou on passe devant, ce qui compte est
 * la silhouette et l'occultation, pas le detail des branches. La geometrie est
 * unitaire (1 m de haut) : l'echelle de chaque instance fait le reste.
 */
function buildTreeGeometry() {
  const parts = [];

  const trunk = new THREE.CylinderGeometry(0.045, 0.07, 0.42, 5);
  trunk.translate(0, 0.21, 0);
  paint(trunk, TRUNK);
  parts.push(trunk);

  const lower = new THREE.ConeGeometry(0.30, 0.52, 7);
  lower.translate(0, 0.56, 0);
  paint(lower, 0x3d5c2c);
  parts.push(lower);

  const upper = new THREE.ConeGeometry(0.21, 0.44, 7);
  upper.translate(0, 0.84, 0);
  paint(upper, 0x4a6b33);
  parts.push(upper);

  return mergeGeometries(parts);
}

function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // variation verticale : le bas du feuillage est plus sombre
    const y = geo.attributes.position.getY(i);
    const f = 0.78 + Math.min(0.32, y * 0.3);
    colors[i * 3] = c.r * f;
    colors[i * 3 + 1] = c.g * f;
    colors[i * 3 + 2] = c.b * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Fusion minimale : position, normal et color, en geometries non indexees. */
function mergeGeometries(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let offset = 0;

  for (const g of parts) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    color.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

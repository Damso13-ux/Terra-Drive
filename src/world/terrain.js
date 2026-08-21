// Streaming du terrain. Une tuile d'altitude (zoom 15, ~890 m de cote) = un chunk.
//
// Principes de fiabilite :
//  - le maillage est cree IMMEDIATEMENT, meme sans donnee (altitude de repli grossiere),
//    puis reconstruit quand la donnee fine arrive ; jamais de trou dans le monde ;
//  - la texture satellite arrive apres, sur un materiau de couleur neutre : on ne voit
//    jamais de damier noir ;
//  - une jupe verticale ferme les bords, ce qui masque les fissures entre niveaux de detail.

import * as THREE from 'three';
import { TILE_PX } from '../core/geo.js';
import { loadImage } from '../core/net.js';

const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

// resolution du maillage par defaut, selon l'anneau de distance
const DEFAULT_LOD = [64, 48, 32, 16, 12];
const SKIRT = 18; // profondeur de la jupe de bord, en metres

export class Terrain {
  constructor({
    scene, proj, heightfield, ground, queue,
    radius = 3,
    lod = DEFAULT_LOD,
    imageryBoost = 2,
    rebuildBudget = 2,
  }) {
    this.scene = scene;
    this.proj = proj;
    this.hf = heightfield;
    this.ground = ground;
    this.queue = queue;
    this.radius = radius;
    this.lod = lod;
    this.imageryBoost = imageryBoost;
    this.zoom = heightfield.fineZoom;
    this.chunks = new Map();
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this.pendingMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b7355,
      roughness: 1.0,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this._rebuildBudget = rebuildBudget; // chunks reconstruits par frame, au maximum
    this.stats = { chunks: 0, textured: 0, rebuilding: 0, textureFailed: 0 };
  }

  key(tx, ty) {
    return tx + '/' + ty;
  }

  _lodFor(ring) {
    return this.lod[Math.min(ring, this.lod.length - 1)];
  }

  chunkBounds(tx, ty) {
    const p = this.proj;
    return {
      minX: p.pixelXToWorld(tx * TILE_PX, this.zoom),
      maxX: p.pixelXToWorld((tx + 1) * TILE_PX, this.zoom),
      minZ: p.pixelYToWorld(ty * TILE_PX, this.zoom),
      maxZ: p.pixelYToWorld((ty + 1) * TILE_PX, this.zoom),
    };
  }

  /** Met a jour l'ensemble des chunks charges autour du joueur. */
  update(playerX, playerZ) {
    const cx = Math.floor(this.proj.worldToPixelX(playerX, this.zoom) / TILE_PX);
    const cy = Math.floor(this.proj.worldToPixelY(playerZ, this.zoom) / TILE_PX);
    const r = this.radius;
    const wanted = new Set();

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (dx * dx + dy * dy > (r + 0.5) * (r + 0.5)) continue;
        const tx = cx + dx, ty = cy + dy;
        const key = this.key(tx, ty);
        wanted.add(key);
        let chunk = this.chunks.get(key);
        if (!chunk) {
          chunk = this._createChunk(tx, ty, ring);
          this.chunks.set(key, chunk);
        } else if (chunk.ring !== ring) {
          chunk.ring = ring;
          if (this._lodFor(ring) !== chunk.res) chunk.dirty = true;
          this._ensureTexture(chunk);
        }
        chunk.priority = ring;
      }
    }

    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) {
        this._disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
    this.stats.chunks = this.chunks.size;

    this._processRebuilds();
  }

  _createChunk(tx, ty, ring) {
    const bounds = this.chunkBounds(tx, ty);
    const chunk = {
      tx,
      ty,
      ring,
      bounds,
      res: 0,
      dirty: true,
      elevVersion: -1,
      roadVersion: -1,
      mesh: null,
      texture: null,
      textureLevel: -1,
      textureRequested: false,
    };
    // priorite negative pour l'anneau 0 : le sol sous les roues passe avant tout
    this.hf.requestFine(tx, ty, ring - 5);
    this._ensureTexture(chunk);
    return chunk;
  }

  _ensureTexture(chunk) {
    // Le chunk sous les roues merite la meilleure imagerie possible : il n'y en a
    // qu'un. L'anneau suivant en recoit une de moins, le reste se contente du
    // niveau du terrain.
    const boost =
      chunk.ring === 0 ? this.imageryBoost : chunk.ring === 1 ? Math.min(1, this.imageryBoost) : 0;
    const level = this.zoom + boost;
    if (chunk.textureLevel >= level || chunk.textureRequested === level) return;
    chunk.textureRequested = level;
    const job =
      level > this.zoom
        ? this._loadComposite(chunk, level)
        : this._loadSingle(chunk, level);
    job
      .then((tex) => {
        if (!this.chunks.has(this.key(chunk.tx, chunk.ty))) {
          tex.dispose();
          return;
        }
        if (chunk.textureLevel >= level) {
          tex.dispose();
          return;
        }
        if (chunk.texture) chunk.texture.dispose();
        chunk.texture = tex;
        chunk.textureLevel = level;
        this.stats.textured++;
        if (chunk.mesh) chunk.mesh.material = this._makeMaterial(tex);
      })
      .catch(() => {
        chunk.textureRequested = -1; // on retentera si le chunk change d'anneau
        this.stats.textureFailed++;
      });
  }

  _makeMaterial(texture) {
    return new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.97,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
  }

  _loadSingle(chunk, level) {
    const url = `${IMAGERY}/${level}/${chunk.ty}/${chunk.tx}`;
    return this.queue
      .add('img' + level + ':' + chunk.tx + '/' + chunk.ty, chunk.ring + 10, () => loadImage(url))
      .then((img) => {
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        return tex;
      });
  }

  /** NxN tuiles d'un niveau superieur, assemblees en une seule texture. */
  _loadComposite(chunk, level) {
    const factor = Math.pow(2, level - this.zoom);
    const bx = chunk.tx * factor;
    const by = chunk.ty * factor;
    const jobs = [];
    for (let j = 0; j < factor; j++) {
      for (let i = 0; i < factor; i++) {
        const x = bx + i, y = by + j;
        const url = `${IMAGERY}/${level}/${y}/${x}`;
        jobs.push(
          this.queue
            .add('img' + level + ':' + x + '/' + y, chunk.ring + 6, () => loadImage(url))
            .then((img) => ({ img, i, j }))
        );
      }
    }
    return Promise.all(jobs).then((parts) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = TILE_PX * factor;
      const ctx = canvas.getContext('2d');
      for (const { img, i, j } of parts) {
        ctx.drawImage(img, i * TILE_PX, j * TILE_PX, TILE_PX, TILE_PX);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      return tex;
    });
  }

  /** Marque a reconstruire tous les chunks recouvrant une zone (arrivee de routes). */
  invalidateArea(minX, minZ, maxX, maxZ) {
    for (const chunk of this.chunks.values()) {
      const b = chunk.bounds;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      chunk.dirty = true;
    }
  }

  invalidateAll() {
    for (const chunk of this.chunks.values()) chunk.dirty = true;
  }

  /**
   * Une tuile d'altitude vient d'arriver : seuls ce chunk et ses voisins immediats
   * sont concernes (l'echantillonnage bilineaire deborde d'un pixel sur les bords).
   */
  markTileDirty(tx, ty) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(this.key(tx + dx, ty + dy));
        if (chunk) chunk.dirty = true;
      }
    }
  }

  _processRebuilds() {
    const todo = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) todo.push(chunk);
    }
    this.stats.rebuilding = todo.length;
    if (!todo.length) return;
    todo.sort((a, b) => a.priority - b.priority);
    const budget = Math.min(this._rebuildBudget, todo.length);
    for (let i = 0; i < budget; i++) this._buildMesh(todo[i]);
  }

  _buildMesh(chunk) {
    chunk.dirty = false;
    chunk.elevVersion = this.hf.version;
    const res = this._lodFor(chunk.ring);
    chunk.res = res;

    const { minX, maxX, minZ, maxZ } = chunk.bounds;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const n = res + 1;
    const vertCount = n * n + 4 * n; // grille + jupe
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const indices = [];

    // grille
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0; j < n; j++) {
      const v = j / res;
      const z = minZ + d * v;
      for (let i = 0; i < n; i++) {
        const u = i / res;
        const x = minX + w * u;
        const y = this.ground.meshHeight(x, z);
        const k = j * n + i;
        positions[k * 3] = x;
        positions[k * 3 + 1] = y;
        positions[k * 3 + 2] = z;
        uvs[k * 2] = u;
        uvs[k * 2 + 1] = 1 - v;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const e = c + 1;
        indices.push(a, c, b, b, c, e);
      }
    }

    // jupe : duplique les bords vers le bas pour boucher les fissures inter-LOD
    let sk = n * n;
    const addSkirt = (getIdx) => {
      const start = sk;
      for (let i = 0; i < n; i++) {
        const src = getIdx(i);
        positions[sk * 3] = positions[src * 3];
        positions[sk * 3 + 1] = positions[src * 3 + 1] - SKIRT;
        positions[sk * 3 + 2] = positions[src * 3 + 2];
        uvs[sk * 2] = uvs[src * 2];
        uvs[sk * 2 + 1] = uvs[src * 2 + 1];
        sk++;
      }
      return start;
    };
    const top = addSkirt((i) => i);
    const bottom = addSkirt((i) => (n - 1) * n + i);
    const left = addSkirt((i) => i * n);
    const right = addSkirt((i) => i * n + (n - 1));
    for (let i = 0; i < n - 1; i++) {
      indices.push(top + i, i, top + i + 1, top + i + 1, i, i + 1);
      const b0 = (n - 1) * n + i;
      indices.push(b0, bottom + i, b0 + 1, b0 + 1, bottom + i, bottom + i + 1);
      const l0 = i * n;
      indices.push(l0, left + i, l0 + n, l0 + n, left + i, left + i + 1);
      const r0 = i * n + (n - 1);
      indices.push(r0, r0 + n, right + i, r0 + n, right + i + 1, right + i);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      Math.hypot(w, d, maxY - minY + SKIRT) * 0.5 + 1
    );

    if (chunk.mesh) {
      chunk.mesh.geometry.dispose();
      chunk.mesh.geometry = geo;
    } else {
      const mat = chunk.texture ? this._makeMaterial(chunk.texture) : this.pendingMaterial;
      chunk.mesh = new THREE.Mesh(geo, mat);
      chunk.mesh.receiveShadow = true;
      chunk.mesh.matrixAutoUpdate = false;
      chunk.mesh.frustumCulled = true;
      this.group.add(chunk.mesh);
    }
  }

  _disposeChunk(chunk) {
    if (chunk.mesh) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      if (chunk.mesh.material !== this.pendingMaterial) chunk.mesh.material.dispose();
      chunk.mesh = null;
    }
    if (chunk.texture) {
      chunk.texture.dispose();
      chunk.texture = null;
    }
  }
}

// Point d'entree : sequence de demarrage, boucle de jeu, cablage des modules.

import * as THREE from 'three';
import { Projection } from './core/geo.js';
import { RequestQueue } from './core/net.js';
import { Heightfield } from './world/heightfield.js';
import { RoadNetwork } from './world/roads.js';
import { Ground } from './world/ground.js';
import { Terrain } from './world/terrain.js';
import { RoadMesh } from './world/roadmesh.js';
import { Buildings } from './world/buildings.js';
import { Vegetation } from './world/vegetation.js';
import { Atmosphere } from './world/sky.js';
import { Vehicle } from './vehicle/car.js';
import { CarView } from './vehicle/carview.js';
import { ChaseCamera } from './core/camera.js';
import { Input } from './core/input.js';
import { Hud } from './ui/hud.js';
import { Picker } from './ui/picker.js';
import { TouchControls } from './ui/touch.js';
import { Settings } from './ui/settings.js';
import { detectDevice, qualityProfile } from './core/device.js';
import { findVehicle, DEFAULT_VEHICLE } from './vehicle/catalogue.js';
import { store } from './core/store.js';

const ROAD_RADIUS = 2600; // rayon de chargement du reseau routier, en metres (bureau)
const SPAWN_SEARCH = 350; // distance max pour trouver une route au point de depart

class Boot {
  constructor(el) {
    this.el = el;
    this.listEl = el.querySelector('[data-steps]');
    this.steps = new Map();
  }
  step(id, label) {
    const row = document.createElement('div');
    row.className = 'boot-step';
    row.innerHTML = `<span class="dot"></span><span class="label">${label}</span><span class="note"></span>`;
    this.listEl.appendChild(row);
    this.steps.set(id, row);
    return row;
  }
  done(id, note = '') {
    const row = this.steps.get(id);
    if (!row) return;
    row.classList.add('ok');
    row.querySelector('.note').textContent = note;
  }
  warn(id, note) {
    const row = this.steps.get(id);
    if (!row) return;
    row.classList.add('warn');
    row.querySelector('.note').textContent = note;
  }
  hide() {
    this.el.classList.remove('visible');
  }
  show() {
    this.el.classList.add('visible');
  }
}

const NEWLINE = String.fromCharCode(10);

/** Preferences persistantes. Le mode prive fait echouer localStorage : on encaisse. */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('terra:' + key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('terra:' + key, value);
    } catch {
      /* rien a faire : ce n'est qu'un confort */
    }
  },
};

/** Couleur moyenne d'une image, pour savoir si une texture est bien coloree. */
function averageColour(image) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  } catch {
    return 'illisible';
  }
}

/** Couleur moyenne de quelques zones de l'image rendue. */
function samplePixels(canvas) {
  try {
    const W = 120, H = 60;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const box = (x0, y0, x1, y1, label) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(y0 * H); y < y1 * H; y++) {
        for (let x = Math.floor(x0 * W); x < x1 * W; x++) {
          const i = (y * W + x) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      return `${label} rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
    };
    return [
      box(0.05, 0.05, 0.95, 0.2, 'ciel   '),
      box(0.05, 0.55, 0.35, 0.75, 'sol G  '),
      box(0.65, 0.55, 0.95, 0.75, 'sol D  '),
      box(0.4, 0.8, 0.6, 0.95, 'sol bas'),
    ];
  } catch (e) {
    return ['lecture impossible : ' + e.message];
  }
}

/** Attend une promesse, mais jamais plus de `ms`. Ne rejette jamais. */
function atMost(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: e })
    ),
    new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), ms)),
  ]);
}

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = detectDevice();
    this.quality = qualityProfile(this.device, prefs.get('quality', 'auto'));
    const q = this.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: q.antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(q.pixelRatio);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.42;
    this._bindContextLoss();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.35, 12000);

    this.clock = new THREE.Clock();
    this.running = false;
    this.paused = false;

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async start(lon, lat, name, boot) {
    this.placeName = name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    this.proj = new Projection(lon, lat);
    // Tuiles et Overpass ont des contraintes opposees : les tuiles aiment le
    // parallelisme, Overpass limite par adresse IP et se ferme si on le bouscule.
    this.queue = new RequestQueue({ concurrency: this.quality.concurrency, retries: 3 });
    this.roadQueue = new RequestQueue({ concurrency: 2, retries: 4, baseDelay: 1400 });

    this.heightfield = new Heightfield(this.proj, this.queue);
    this.roads = new RoadNetwork(this.proj, this.heightfield, this.roadQueue);
    this.ground = new Ground(this.heightfield, this.roads);

    // ---- 1. filet de securite altimetrique -------------------------------
    boot.step('coarse', 'Relief general');
    const coarse = await atMost(this.heightfield.primeCoarse(1), 12000);
    if (coarse.ok) boot.done('coarse', 'charge');
    else boot.warn('coarse', 'indisponible, on continue');

    // ---- 2. relief detaille sous le point de depart -----------------------
    boot.step('fine', 'Relief detaille');
    const { TILE_PX } = await import('./core/geo.js');
    const tx = Math.floor(this.proj.worldToPixelX(0, this.heightfield.fineZoom) / TILE_PX);
    const ty = Math.floor(this.proj.worldToPixelY(0, this.heightfield.fineZoom) / TILE_PX);
    const fine = await atMost(this.heightfield.requestFine(tx, ty, -100), 12000);
    if (this.heightfield.hasFine(0, 0)) boot.done('fine', 'charge');
    else boot.warn('fine', 'repli sur le relief general');

    // ---- 3. reseau routier ------------------------------------------------
    boot.step('roads', 'Trace des routes');
    this.roads.ensureArea(0, 0, 900);
    const gotRoads = await atMost(this.waitForRoads(), 25000);
    if (gotRoads.ok) boot.done('roads', this.roads.stats.ways + ' voies');
    else boot.warn('roads', 'aucune route trouvee ici');

    // ---- 4. scene ---------------------------------------------------------
    boot.step('scene', 'Construction du monde');
    const q = this.quality;
    this.atmosphere = new Atmosphere(this.scene, this.renderer, {
      hour: 10,
      fogDistance: q.fogDistance,
      shadows: q.shadows,
      shadowMapSize: q.shadowMapSize,
      environmentMap: q.environmentMap,
    });
    this.terrain = new Terrain({
      scene: this.scene,
      proj: this.proj,
      heightfield: this.heightfield,
      ground: this.ground,
      queue: this.queue,
      radius: q.terrainRadius,
      lod: q.lod,
      imageryBoost: q.imageryBoost,
      rebuildBudget: q.rebuildBudget,
    });
    this.roadMesh = new RoadMesh({ scene: this.scene, roads: this.roads, radius: q.roadRadius });
    this.buildings = new Buildings({
      scene: this.scene,
      proj: this.proj,
      ground: this.ground,
      radius: q.buildingRadius,
      maxPerCell: q.buildingsPerCell,
      minArea: q.buildingMinArea,
    });
    this.buildings.setEnabled(this.detailEnabled('buildings', q.buildings));
    // Les emprises arrivent dans la meme requete Overpass que les routes.
    this.roads.setBuildingSink((cell, elements) => this.buildings.ingest(cell, elements));

    this.vegetation = new Vegetation({
      scene: this.scene,
      proj: this.proj,
      ground: this.ground,
      radius: q.buildingRadius,
      maxPerCell: q.treesPerCell,
      enabled: q.vegetation,
    });
    this.vegetation.setEnabled(this.detailEnabled('vegetation', q.vegetation));
    this.roads.setVegetationSink((cell, elements) => this.vegetation.ingest(cell, elements));
    this.heightfield.onTile = (tx2, ty2) => this.terrain.markTileDirty(tx2, ty2);

    const chosen = findVehicle(prefs.get('vehicle', DEFAULT_VEHICLE));
    this.vehicleEntry = chosen;
    this.vehicle = new Vehicle(this.ground, { ...chosen.config, substep: q.substep });
    this.carView = new CarView(this.scene, this.vehicle, {
      color: chosen.colour,
      skidPoints: q.skidPoints,
    });
    this.chase = new ChaseCamera(this.camera, this.ground);
    this.input = new Input();

    this.hud = new Hud(document.getElementById('hud'), { compact: this.device.mobile });
    this.actions = this.buildActions();
    this.settings = new Settings(document.getElementById('settings'), {
      onVehicle: (id) => this.setVehicle(id),
      onQuality: (preset) => {
        const q = this.applyQuality(preset);
        this.hud.toast('Qualite : ' + q.resolved);
      },
      onAssists: () => this.actions.assists(),
      onDetail: (name, on) => this.setDetail(name, on),
      getState: () => ({
        vehicleId: this.vehicleEntry.id,
        preset: this.quality.preset,
        resolved: this.quality.resolved,
        quality: this.quality,
        assists: this.vehicle.assists.abs && this.vehicle.assists.tcs,
        buildings: this.buildings.enabled,
        vegetation: this.vegetation.enabled,
      }),
    });
    if (this.device.mobile) this.setupTouch();
    this.spawn();

    // pre-construction : on remplit les chunks proches avant d'afficher quoi que ce soit
    this.terrain._rebuildBudget = 64;
    this.terrain.update(this.vehicle.position.x, this.vehicle.position.z);
    this.roadMesh.update(this.vehicle.position.x, this.vehicle.position.z);
    this.terrain._rebuildBudget = q.rebuildBudget;
    boot.done('scene', this.terrain.stats.chunks + ' chunks');

    this.bindKeys();
    this.running = true;
    this.clock.start();
    this.loop();
    return true;
  }

  /**
   * Attend une route reellement UTILISABLE sous le point de depart.
   *
   * Se contenter de `stats.ways > 0` etait une course perdue d'avance : les cellules
   * arrivent dans le desordre, et celle situee a 1,2 km repondait souvent en premier.
   * La voiture etait alors posee a l'aveugle sur l'origine, en plein champ.
   */
  waitForRoads() {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (this.roads.nearestRoad(0, 0, SPAWN_SEARCH)) return resolve(true);
        const states = [...this.roads.cells.values()];
        const settled = states.length && states.every((s) => s !== 'loading');
        if (settled) {
          // plus rien en vol : soit il n'y a vraiment aucune route ici, soit elles
          // sont toutes trop loin du point vise
          return this.roads.stats.ways > 0
            ? resolve(true)
            : reject(new Error('aucune route a proximite'));
        }
        if (performance.now() - started > 24000) return reject(new Error('delai depasse'));
        setTimeout(check, 250);
      };
      check();
    });
  }

  get storageKey() {
    return 'terra:pos:' + location.hash;
  }

  /** Les navigateurs mobiles rechargent les onglets sans prevenir : on garde la place. */
  remember() {
    try {
      const p = this.vehicle.position;
      const q = this.vehicle.quaternion;
      const heading = Math.atan2(
        2 * (q.w * q.y + q.x * q.z),
        1 - 2 * (q.y * q.y + q.x * q.x)
      );
      sessionStorage.setItem(
        this.storageKey,
        JSON.stringify({ x: p.x, z: p.z, heading, odo: this.vehicle.odometer })
      );
    } catch {
      /* mode navigation privee : tant pis, ce n'est qu'un confort */
    }
  }

  forget() {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {}
  }

  recall() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
    } catch {
      return null;
    }
  }

  /** Place la voiture sur la route la plus proche, ou a defaut sur le terrain. */
  spawn() {
    const saved = this.recall();
    if (saved) {
      const near = this.roads.nearestRoad(saved.x, saved.z, 120);
      if (near) {
        this.vehicle.placeAt(near.x, near.y, near.z, saved.heading);
      } else {
        this.vehicle.placeAt(saved.x, this.ground.height(saved.x, saved.z), saved.z, saved.heading);
      }
      this.vehicle.odometer = saved.odo || 0;
      this.spawnPoint = { x: saved.x, y: this.vehicle.position.y, z: saved.z, heading: saved.heading };
      this.spawnedOnRoad = true;
      this.rescueTimer = 0;
      return;
    }
    const near = this.roads.nearestRoad(0, 0, SPAWN_SEARCH);
    if (near) {
      this.vehicle.placeAt(near.x, near.y, near.z, near.heading);
      this.spawnPoint = { x: near.x, y: near.y, z: near.z, heading: near.heading };
      this.spawnedOnRoad = true;
    } else {
      const y = this.ground.height(0, 0);
      this.vehicle.placeAt(0, y, 0, 0);
      this.spawnPoint = { x: 0, y, z: 0, heading: 0 };
      this.spawnedOnRoad = false;
    }
    this.rescueTimer = 0;
  }

  /**
   * Rattrapage : si Overpass a ete trop lent au demarrage, la voiture a ete posee en
   * plein champ. Des que les routes arrivent, on l'y replace -- mais uniquement tant
   * que le joueur n'a pas pris la main, pour ne jamais teleporter quelqu'un qui roule.
   */
  rescueSpawn(dt) {
    if (this.spawnedOnRoad) return;
    this.rescueTimer += dt;
    if (this.rescueTimer < 1) return;
    this.rescueTimer = 0;

    const touched =
      this.vehicle.odometer > 25 ||
      this.input.state.throttle > 0.02 ||
      this.input.state.brake > 0.02 ||
      Math.abs(this.input.state.steer) > 0.02;
    if (touched) {
      this.spawnedOnRoad = true; // le joueur conduit : on ne touche plus a rien
      return;
    }

    const near = this.roads.nearestRoad(0, 0, SPAWN_SEARCH);
    if (!near) return;
    this.vehicle.placeAt(near.x, near.y, near.z, near.heading);
    this.spawnPoint = { x: near.x, y: near.y, z: near.z, heading: near.heading };
    this.spawnedOnRoad = true;
    this.hud.toast('Routes chargees : mise en place sur la chaussee');
  }

  /** Remet la voiture sur la route la plus proche de sa position actuelle. */
  respawn() {
    const p = this.vehicle.position;
    const near = this.roads.nearestRoad(p.x, p.z, 500);
    if (near) this.vehicle.placeAt(near.x, near.y, near.z, near.heading);
    else this.vehicle.rightUp();
    this.carView.skid.clear();
    this.hud.toast('Remis sur la route');
  }

  /**
   * Rapport technique lisible, destine a etre lu (ou photographie) sur l'appareil.
   * Il repond a la seule question qui compte quand l'image est noire : est-ce que
   * la geometrie manque, est-ce que les textures manquent, ou est-ce que la
   * lumiere n'arrive pas ?
   */
  buildReport() {
    const L = [];
    const q = this.quality;
    const v = this.vehicle;
    const gl = this.renderer.getContext();

    L.push('— APPAREIL —');
    L.push('mobile ' + this.device.mobile + ', coeurs ' + this.device.cores);
    L.push('pixelRatio ' + q.pixelRatio + ' (ecran ' + devicePixelRatio + ')');
    L.push('ecran ' + innerWidth + 'x' + innerHeight);
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      L.push('gpu ' + String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 58));
    } catch { L.push('gpu inconnu'); }
    L.push('webgl2 ' + (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext));
    L.push('texture max ' + gl.getParameter(gl.MAX_TEXTURE_SIZE));

    L.push('');
    L.push('— MONDE —');
    L.push('chunks ' + this.terrain.stats.chunks + ', maillage anneau0 ' + this.terrain._lodFor(0));
    L.push('textures ' + this.terrain.stats.textured + ' ok / ' + this.terrain.stats.textureFailed + ' ko');
    L.push('routes ' + this.roads.stats.ways + ', rubans ' + this.roadMesh.stats.tris + ' tri');
    L.push('batiments ' + this.buildings.stats.count + ' sur ' + this.buildings.stats.cells + ' cellules');
    L.push('arbres ' + this.vegetation.stats.trees);
    L.push('cache overpass ' + store.hits + ' repris / ' + store.misses + ' manques');
    L.push('altitude ' + ['ABSENTE', 'approchee', 'fine'][this.heightfield.lastQuality]);
    L.push('sol ' + this.ground.height(v.position.x, v.position.z).toFixed(0) + ' m');
    L.push('voiture/sol ' + (v.position.y - this.ground.height(v.position.x, v.position.z)).toFixed(2) + ' m');
    L.push('camera/sol ' + (this.camera.position.y - this.ground.height(this.camera.position.x, this.camera.position.z)).toFixed(1) + ' m');
    L.push('roues au sol ' + v.wheels.filter((w) => w.grounded).length + '/4');
    L.push('objets scene ' + this.scene.children.length);

    L.push('');
    L.push('— LUMIERE —');
    L.push('exposition ' + this.renderer.toneMappingExposure);
    L.push('soleil ' + this.atmosphere.sun.intensity.toFixed(2) + ' pos y ' + this.atmosphere.sun.position.y.toFixed(0));
    L.push('hemispherique ' + this.atmosphere.hemi.intensity.toFixed(2));
    L.push('environnement ' + (this.scene.environment ? 'present x' + this.scene.environmentIntensity : 'ABSENT'));
    L.push('ombres ' + this.renderer.shadowMap.enabled);
    L.push('brume ' + Math.round(this.scene.fog.near) + '-' + Math.round(this.scene.fog.far) + ' #' + this.scene.fog.color.getHexString());

    // Materiau et texture d'un chunk : la texture est-elle vraiment coloree ?
    const chunk = [...this.terrain.chunks.values()].find((c) => c.mesh);
    if (chunk) {
      L.push('');
      L.push('— UN CHUNK —');
      const m = chunk.mesh.material;
      L.push('materiau ' + m.type + (m === this.terrain.pendingMaterial ? ' (SANS TEXTURE)' : ''));
      L.push('carte ' + (m.map ? 'oui' : 'NON') + ', visible ' + chunk.mesh.visible);
      L.push('triangles ' + (chunk.mesh.geometry.index.count / 3));
      if (m.map && m.map.image) {
        L.push('texture moyenne ' + averageColour(m.map.image));
      }
    }

    L.push('');
    L.push('— PIXELS RENDUS —');
    this.renderer.render(this.scene, this.camera);
    const pix = samplePixels(this.renderer.domElement);
    for (const line of pix) L.push(line);

    return L.join(NEWLINE);
  }

  /**
   * Change de vehicule sans quitter la partie : on garde la place exacte, le cap
   * et l'etat des phares.
   */
  setVehicle(id) {
    const entry = findVehicle(id);
    prefs.set('vehicle', entry.id);
    if (!this.vehicle || entry.id === this.vehicleEntry.id) return entry;

    const p = this.vehicle.position.clone();
    const q = this.vehicle.quaternion;
    const heading = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.x * q.x)
    );
    const lights = this.carView.lightsOn;

    this.carView.dispose();
    this.vehicleEntry = entry;
    this.vehicle = new Vehicle(this.ground, { ...entry.config, substep: this.quality.substep });
    this.carView = new CarView(this.scene, this.vehicle, {
      color: entry.colour,
      skidPoints: this.quality.skidPoints,
    });
    this.vehicle.placeAt(p.x, this.ground.height(p.x, p.z), p.z, heading);
    this.carView.setLights(lights);
    this.hud.toast(entry.name);
    return entry;
  }

  /**
   * Un reglage de detail peut valoir 'auto' (suivre le preset), '1' ou '0'.
   * Choisir un preset efface les reglages manuels : c'est ce qu'on attend d'un
   * preset, et cela evite qu'un vieux choix oublie contredise silencieusement
   * le niveau demande.
   */
  detailEnabled(name, fromPreset) {
    const v = prefs.get('detail:' + name, 'auto');
    return v === 'auto' ? fromPreset : v === '1';
  }

  setDetail(name, on) {
    prefs.set('detail:' + name, on ? '1' : '0');
    this.applyQuality(this.quality.preset, false);
  }

  /** Applique un preset de qualite a chaud, sans recharger la page. */
  applyQuality(preset, clearDetails = true) {
    prefs.set('quality', preset);
    if (clearDetails) {
      prefs.set('detail:buildings', 'auto');
      prefs.set('detail:vegetation', 'auto');
    }
    const q = (this.quality = qualityProfile(this.device, preset));

    this.renderer.setPixelRatio(q.pixelRatio);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.atmosphere.setShadows(q.shadows);

    this.scene.fog.far = q.fogDistance;
    this.scene.fog.near = q.fogDistance * 0.62;

    this.terrain.radius = q.terrainRadius;
    this.terrain.lod = q.lod;
    this.terrain.imageryBoost = q.imageryBoost;
    this.terrain._rebuildBudget = q.rebuildBudget;
    this.terrain.invalidateAll();
    this.terrain.refreshTextures();

    this.roadMesh.radius = q.roadRadius;
    this.buildings.radius = q.buildingRadius;
    this.buildings.setEnabled(this.detailEnabled('buildings', q.buildings));
    this.vegetation.radius = q.buildingRadius;
    this.vegetation.setEnabled(this.detailEnabled('vegetation', q.vegetation));
    this.vehicle.substep = q.substep;

    // Basculer les ombres change le programme des shaders : il faut le signaler.
    this.scene.traverse((o) => {
      if (!o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) m.needsUpdate = true;
    });

    this.resize();
    return q;
  }

  /** Actions du jeu, partagees par le clavier et les commandes tactiles. */
  buildActions() {
    return {
      respawn: () => this.respawn(),
      camera: () => this.hud.toast('Camera : ' + this.chase.cycleMode()),
      lights: () => {
        this.carView.setLights(!this.carView.lightsOn);
        this.hud.toast('Phares ' + (this.carView.lightsOn ? 'allumes' : 'eteints'));
      },
      time: () => {
        const next = (Math.round(this.atmosphere.hour) + 3) % 24;
        this.atmosphere.setHour(next);
        this.carView.setLights(this.atmosphere.isNight);
        this.hud.toast('Heure : ' + String(next).padStart(2, '0') + ' h');
      },
      assists: () => {
        const a = this.vehicle.assists;
        const on = !(a.abs && a.tcs);
        a.abs = a.tcs = on;
        this.hud.toast('Aides ' + (on ? 'activees' : 'desactivees'));
      },
      diag: () => this.hud.toggleDiag(),
      pause: () => {
        this.paused = !this.paused;
        this.hud.toast(this.paused ? 'Pause' : 'Reprise');
      },
      place: () => {
        this.forget();
        location.hash = '';
        location.reload();
      },
      hint: (message) => this.hud.toast(message),
      report: () => this.buildReport(),
      settings: () => this.settings.toggle(),
    };
  }

  setupTouch() {
    this.actions = this.actions || this.buildActions();
    this.touch = new TouchControls(document.getElementById('touch'), this.actions);
    this.input.setTouch(this.touch);
    this.touch.show();
  }

  /**
   * Un navigateur mobile n'hesite pas a reprendre le contexte WebGL quand on change
   * d'application. Le reconstruire a la main serait fragile ; comme le lieu est dans
   * l'URL et la position en sessionStorage, un rechargement remet tout d'aplomb.
   */
  _bindContextLoss() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.running = false;
      document.getElementById('lost')?.classList.add('visible');
    });
    this.canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  bindKeys() {
    const i = this.input;
    const a = (this.actions = this.actions || this.buildActions());
    i.on('KeyR', a.respawn);
    i.on('KeyC', a.camera);
    i.on('KeyL', a.lights);
    i.on('KeyT', a.time);
    i.on('KeyH', a.place);
    i.on('F3', a.diag);
    i.on('KeyP', a.pause);
    i.on('KeyG', a.assists);
    i.on('KeyO', a.settings);
    i.on('Escape', () => this.settings.close());

    // souris pour la camera orbitale
    let dragging = false;
    let lastX = 0, lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.chase.orbitDrag(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', () => (dragging = false));
    this.canvas.addEventListener('wheel', (e) => {
      this.chase.orbitZoom(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (dt <= 0) return;

    if (!this.paused) {
      const input = this.input.update(dt);
      this.vehicle.setInput(input);
      this.vehicle.update(dt);
      this._resolveBuildings();
    }

    this.rescueSpawn(dt);

    this._saveTimer = (this._saveTimer || 0) + dt;
    if (this._saveTimer > 2) {
      this._saveTimer = 0;
      this.remember();
    }

    const p = this.vehicle.position;
    this.heightfield.tick(dt);
    this.terrain.update(p.x, p.z);
    this.roads.ensureArea(p.x, p.z, this.device.mobile ? 1500 : ROAD_RADIUS);
    this.roadMesh.update(p.x, p.z);
    this.buildings.update(p.x, p.z);
    this.vegetation.update(p.x, p.z);
    this.atmosphere.update(p, dt);
    this.chase.update(this.vehicle, dt);
    this.carView.update(dt);

    this.frames = (this.frames || 0) + 1;
    this.hud.update(dt, {
      vehicle: this.vehicle,
      camera: this.camera,
      frames: this.frames,
      road: this.roads.queryGround(p.x, p.z),
      renderedGround: this.renderedGround,
      textureAverage: this.textureAverage,
      atmosphere: this.atmosphere,
      roads: this.roads,
      terrain: this.terrain,
      queue: this.queue,
      roadQueue: this.roadQueue,
      heightfield: this.heightfield,
      placeName: this.placeName,
    });

    this.renderer.render(this.scene, this.camera);

    // Echantillonnage de controle, juste apres le rendu : sans
    // preserveDrawingBuffer le contenu du canvas n'est lisible que maintenant.
    this._probeTimer = (this._probeTimer || 0) + dt;
    if (this._probeTimer > 0.5) {
      this._probeTimer = 0;
      this.renderedGround = probeGround(this.renderer.domElement);
      if (!this.textureAverage) {
        const chunk = [...this.terrain.chunks.values()].find((c) => c.texture && c.texture.image);
        if (chunk) this.textureAverage = averageColour(chunk.texture.image);
      }
      this._checkLighting();
    }
  }

  /**
   * Empeche la voiture d'entrer dans un batiment.
   *
   * Correction de position plutot que vraie collision de corps rigide : c'est
   * inconditionnellement stable et cela suffit pour des obstacles statiques. Sans
   * elle on traverse les facades, et a Monaco on passe son temps dans les murs,
   * camera comprise.
   */
  _resolveBuildings() {
    const v = this.vehicle;
    const push = this.buildings.resolve(
      v.position.x,
      v.position.z,
      v.cfg.bodyWidth * 0.5 + 0.15
    );
    if (!push) return;

    v.position.x += push.x;
    v.position.z += push.z;

    const len = Math.hypot(push.x, push.z) || 1;
    const nx = push.x / len;
    const nz = push.z / len;
    const into = v.velocity.x * nx + v.velocity.z * nz;
    if (into < 0) {
      // on annule la composante qui rentrait dans le mur, plus un rebond discret
      v.velocity.x -= into * nx * 1.15;
      v.velocity.z -= into * nz * 1.15;
    }
  }

  /**
   * Auto-reparation de l'eclairage.
   *
   * Sur certains GPU mobiles (constate sur un Mali-G1-Ultra) la carte
   * d'environnement generee par PMREM sort invalide : un NaN se propage dans le
   * calcul d'eclairage et TOUTE la scene devient noire, alors que les textures,
   * la geometrie et les lumieres sont parfaitement correctes. Symptome typique :
   * le ciel s'affiche normalement (il n'est pas eclaire) et seul le lointain
   * reste visible, parce que la brume s'applique apres l'eclairage.
   *
   * Plutot que de tenir une liste de GPU fautifs, on regarde le resultat.
   */
  _checkLighting() {
    if (this._lightingChecked || !this.renderedGround) return;
    if (this.frames < 150) return; // laisser le monde se construire
    if (this.terrain.stats.textured === 0) return;
    if (this.atmosphere.isNight) return; // la nuit, du noir est legitime

    const [r, g, b] = this.renderedGround.split(',').map(Number);
    if (!Number.isFinite(r)) return;
    this._lightingChecked = true;
    if (r + g + b > 8) return; // rendu normal

    if (this.atmosphere.disableEnvironment()) {
      this.renderedGround = null;
      this._lightingChecked = false; // on verifiera que le correctif a pris
      this.hud.toast('Eclairage adapte a ta carte graphique');
    }
  }
}

/** Couleur moyenne du bas de l'image : c'est le sol, juste devant la voiture. */
function probeGround(canvas) {
  try {
    const W = 60, H = 40;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0, W, H);
    const d = ctx.getImageData(0, Math.floor(H * 0.62), W, Math.floor(H * 0.3)).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
  } catch {
    return 'illisible';
  }
}

// ---------------------------------------------------------------------------

const boot = new Boot(document.getElementById('boot'));
const canvas = document.getElementById('view');
const picker = new Picker(document.getElementById('picker'), {
  onPick: ({ lat, lon, name }) => {
    location.hash = `${lat.toFixed(6)},${lon.toFixed(6)}` + (name ? ',' + encodeURIComponent(name) : '');
    location.reload();
  },
});

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const [lat, lon, name] = raw.split(',');
  const la = parseFloat(lat);
  const lo = parseFloat(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return { lat: la, lon: lo, name: name ? decodeURIComponent(name) : null };
}

const target = parseHash();
if (!target) {
  picker.show();
} else {
  boot.show();
  const game = new Game(canvas);
  window.game = game;
  game.start(target.lon, target.lat, target.name, boot).then(
    () => {
      setTimeout(() => boot.hide(), 400);
      document.getElementById('hud').classList.add('visible');
    },
    (err) => {
      console.error(err);
      boot.step('fail', 'Echec du demarrage');
      boot.warn('fail', String(err && err.message ? err.message : err));
    }
  );
}

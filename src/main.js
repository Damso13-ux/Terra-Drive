// Point d'entree : sequence de demarrage, boucle de jeu, cablage des modules.

import * as THREE from 'three';
import { Projection } from './core/geo.js';
import { RequestQueue } from './core/net.js';
import { Heightfield } from './world/heightfield.js';
import { RoadNetwork } from './world/roads.js';
import { Ground } from './world/ground.js';
import { Terrain } from './world/terrain.js';
import { RoadMesh } from './world/roadmesh.js';
import { Atmosphere } from './world/sky.js';
import { Vehicle } from './vehicle/car.js';
import { CarView } from './vehicle/carview.js';
import { ChaseCamera } from './core/camera.js';
import { Input } from './core/input.js';
import { Hud } from './ui/hud.js';
import { Picker } from './ui/picker.js';

const ROAD_RADIUS = 2600; // rayon de chargement du reseau routier, en metres

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
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.78;

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
    this.queue = new RequestQueue({ concurrency: 10, retries: 3 });

    this.heightfield = new Heightfield(this.proj, this.queue);
    this.roads = new RoadNetwork(this.proj, this.heightfield, this.queue);
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
    this.atmosphere = new Atmosphere(this.scene, this.renderer, { hour: 10 });
    this.terrain = new Terrain({
      scene: this.scene,
      proj: this.proj,
      heightfield: this.heightfield,
      ground: this.ground,
      queue: this.queue,
      radius: 3,
    });
    this.roadMesh = new RoadMesh({ scene: this.scene, roads: this.roads, radius: 2 });
    this.heightfield.onTile = (tx2, ty2) => this.terrain.markTileDirty(tx2, ty2);

    this.vehicle = new Vehicle(this.ground);
    this.carView = new CarView(this.scene, this.vehicle);
    this.chase = new ChaseCamera(this.camera, this.ground);
    this.input = new Input();

    this.hud = new Hud(document.getElementById('hud'));
    this.spawn();

    // pre-construction : on remplit les chunks proches avant d'afficher quoi que ce soit
    this.terrain._rebuildBudget = 64;
    this.terrain.update(this.vehicle.position.x, this.vehicle.position.z);
    this.roadMesh.update(this.vehicle.position.x, this.vehicle.position.z);
    this.terrain._rebuildBudget = 2;
    boot.done('scene', this.terrain.stats.chunks + ' chunks');

    this.bindKeys();
    this.running = true;
    this.clock.start();
    this.loop();
    return true;
  }

  /** Attend qu'au moins une cellule de routes soit exploitable. */
  waitForRoads() {
    return new Promise((resolve, reject) => {
      if (this.roads.stats.ways > 0) return resolve(true);
      const started = performance.now();
      const check = () => {
        if (this.roads.stats.ways > 0) return resolve(true);
        // toutes les cellules demandees ont echoue ou sont vides
        const states = [...this.roads.cells.values()];
        if (states.length && states.every((s) => s !== 'loading')) return reject(new Error('vide'));
        if (performance.now() - started > 24000) return reject(new Error('timeout'));
        setTimeout(check, 250);
      };
      check();
    });
  }

  /** Place la voiture sur la route la plus proche, ou a defaut sur le terrain. */
  spawn() {
    const near = this.roads.nearestRoad(0, 0, 400);
    if (near) {
      this.vehicle.placeAt(near.x, near.y, near.z, near.heading);
      this.spawnPoint = { x: near.x, y: near.y, z: near.z, heading: near.heading };
    } else {
      const y = this.ground.height(0, 0);
      this.vehicle.placeAt(0, y, 0, 0);
      this.spawnPoint = { x: 0, y, z: 0, heading: 0 };
    }
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

  bindKeys() {
    const i = this.input;
    i.on('KeyR', () => this.respawn());
    i.on('KeyC', () => this.hud.toast('Camera : ' + this.chase.cycleMode()));
    i.on('KeyL', () => {
      this.carView.setLights(!this.carView.lightsOn);
      this.hud.toast('Phares ' + (this.carView.lightsOn ? 'allumes' : 'eteints'));
    });
    i.on('KeyT', () => {
      const next = (Math.round(this.atmosphere.hour) + 3) % 24;
      this.atmosphere.setHour(next);
      this.carView.setLights(this.atmosphere.isNight);
      this.hud.toast('Heure : ' + String(next).padStart(2, '0') + ' h');
    });
    i.on('KeyH', () => {
      location.hash = '';
      location.reload();
    });
    i.on('F3', () => this.hud.toggleDiag());
    i.on('KeyP', () => {
      this.paused = !this.paused;
      this.hud.toast(this.paused ? 'Pause' : 'Reprise');
    });
    i.on('KeyG', () => {
      const a = this.vehicle.assists;
      const on = !(a.abs && a.tcs);
      a.abs = a.tcs = on;
      this.hud.toast('Aides ' + (on ? 'activees' : 'desactivees'));
    });

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
    }

    const p = this.vehicle.position;
    this.heightfield.tick(dt);
    this.terrain.update(p.x, p.z);
    this.roads.ensureArea(p.x, p.z, ROAD_RADIUS);
    this.roadMesh.update(p.x, p.z);
    this.atmosphere.update(p, dt);
    this.chase.update(this.vehicle, dt);
    this.carView.update(dt);

    this.hud.update(dt, {
      vehicle: this.vehicle,
      roads: this.roads,
      terrain: this.terrain,
      queue: this.queue,
      heightfield: this.heightfield,
      placeName: this.placeName,
    });

    this.renderer.render(this.scene, this.camera);
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

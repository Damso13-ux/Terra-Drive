// Interface de conduite : compteur, minicarte orientee, panneau de diagnostic.
// Le panneau de diagnostic est volontairement visible : quand quelque chose ne charge
// pas, on doit le voir, pas le deviner.

const MINIMAP_RANGE = 280; // metres representes du centre au bord

const ROAD_STYLE = {
  0: { w: 3.2, c: '#e8a33d' },
  1: { w: 3.0, c: '#e8a33d' },
  2: { w: 2.6, c: '#e5c76b' },
  3: { w: 2.2, c: '#d8d8d0' },
  4: { w: 1.8, c: '#c8c8c0' },
  5: { w: 1.4, c: '#a8a8a2' },
  6: { w: 1.2, c: '#98988f' },
  7: { w: 1.0, c: '#7d7d76' },
  8: { w: 1.0, c: '#8a7a5c' },
};

/** Nom du GPU, quand le navigateur veut bien le donner. */
function describeGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'aucun WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name).slice(0, 60);
  } catch {
    return 'inconnu';
  }
}

export class Hud {
  constructor(root, { compact = false } = {}) {
    this.root = root;
    this.compact = compact;
    if (compact) root.classList.add('compact');
    root.innerHTML = `
      <div class="hud-topright">
        <canvas class="minimap" width="200" height="200"></canvas>
        <div class="diag" data-diag></div>
      </div>
      <div class="hud-bottom">
        <div class="cluster">
          <div class="rpm"><div class="rpm-fill" data-rpm></div></div>
          <div class="readout">
            <span class="speed" data-speed>0</span>
            <span class="unit">km/h</span>
            <span class="gear" data-gear>1</span>
          </div>
          <div class="place" data-place></div>
        </div>
      </div>
      <div class="toast" data-toast></div>
    `;
    this.speedEl = root.querySelector('[data-speed]');
    this.gearEl = root.querySelector('[data-gear]');
    this.rpmEl = root.querySelector('[data-rpm]');
    this.placeEl = root.querySelector('[data-place]');
    this.diagEl = root.querySelector('[data-diag]');
    this.toastEl = root.querySelector('[data-toast]');
    this.canvas = root.querySelector('.minimap');
    this.ctx = this.canvas.getContext('2d');

    this.fps = 60;
    this._acc = 0;
    this._toastTimer = 0;
    this.showDiag = true;
    this.gpu = describeGpu();
  }

  toast(message, seconds = 2.6) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('visible');
    this._toastTimer = seconds;
  }

  toggleDiag() {
    this.showDiag = !this.showDiag;
    this.diagEl.style.display = this.showDiag ? '' : 'none';
  }

  update(dt, ctx) {
    const { vehicle, roads, placeName } = ctx;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.08;

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('visible');
    }

    this._acc += dt;
    if (this._acc < 1 / 20) return; // 20 Hz suffit pour du DOM
    this._acc = 0;

    const kmh = Math.abs(vehicle.speedKmh);
    this.speedEl.textContent = kmh < 1 ? '0' : Math.round(kmh);
    this.gearEl.textContent = vehicle.gearLabel;
    const rev = Math.min(1, vehicle.rpm / vehicle.cfg.redlineRpm);
    this.rpmEl.style.width = (rev * 100).toFixed(1) + '%';
    this.rpmEl.classList.toggle('redline', rev > 0.92);
    if (placeName !== undefined) this.placeEl.textContent = placeName;

    if (this.showDiag) this._drawDiag(ctx);
    this._drawMinimap(vehicle, roads);
  }

  _drawDiag({ roads, terrain, queue, roadQueue, heightfield, vehicle, camera, frames }) {
    const pending = queue.queued + queue.active + roadQueue.queued + roadQueue.active;
    const failed = queue.stats.failed + roadQueue.stats.failed;
    const quality = heightfield.lastQuality;
    const qualityLabel = quality === 2 ? 'fine' : quality === 1 ? 'approchee' : 'ABSENTE';

    // Les deux mesures qui expliquent un ecran noir ou une voiture immobile :
    // la voiture est-elle sous le sol, et la camera est-elle dans le decor ?
    const p = vehicle.position;
    const solVoiture = vehicle.ground.height(p.x, p.z);
    const dVoiture = p.y - solVoiture;
    const solCamera = vehicle.ground.height(camera.position.x, camera.position.z);
    const dCamera = camera.position.y - solCamera;

    const row = (label, value, bad) =>
      `<div class="diag-row"><span>${label}</span><b class="${bad ? 'warn' : ''}">${value}</b></div>`;

    this.diagEl.innerHTML =
      row('images', frames, frames < 5) +
      row('fps', Math.round(this.fps)) +
      row('altitude', qualityLabel, quality < 2) +
      row('sol', solVoiture.toFixed(0) + ' m') +
      row('voiture / sol', (dVoiture >= 0 ? '+' : '') + dVoiture.toFixed(2) + ' m', dVoiture < -0.5) +
      row('camera / sol', (dCamera >= 0 ? '+' : '') + dCamera.toFixed(1) + ' m', dCamera < 0.5) +
      row('roues au sol', vehicle.wheels.filter((w) => w.grounded).length + '/4',
          vehicle.wheels.filter((w) => w.grounded).length === 0) +
      row('chunks', terrain.stats.chunks, terrain.stats.chunks === 0) +
      row('textures', terrain.stats.textured + ' ok / ' + terrain.stats.textureFailed + ' ko',
          terrain.stats.textureFailed > 0) +
      row('routes', roads.stats.ways, roads.stats.ways === 0) +
      row('en attente', pending) +
      row('echecs reseau', failed, failed > 0) +
      `<div class="diag-row wide"><span>gpu</span><b>${this.gpu}</b></div>`;
  }

  _drawMinimap(vehicle, roads) {
    const ctx = this.ctx;
    const size = this.canvas.width;
    const half = size / 2;
    const scale = half / MINIMAP_RANGE;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(12,16,20,0.72)';
    ctx.fillRect(0, 0, size, size);

    const px = vehicle.position.x;
    const pz = vehicle.position.z;
    const fwd = { x: 0, z: -1 };
    const q = vehicle.quaternion;
    // heading depuis le quaternion (composante lacet uniquement)
    const heading = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.x * q.x)
    );

    ctx.translate(half, half);
    ctx.rotate(heading);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const cellSize = 1200;
    const cx = Math.floor(px / cellSize);
    const cz = Math.floor(pz / cellSize);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ways = roads.wayCells.get(cx + dx + ',' + (cz + dz));
        if (!ways) continue;
        for (const way of ways) {
          const b = way.bbox;
          if (
            b.maxX < px - MINIMAP_RANGE || b.minX > px + MINIMAP_RANGE ||
            b.maxZ < pz - MINIMAP_RANGE || b.minZ > pz + MINIMAP_RANGE
          ) continue;
          const style = ROAD_STYLE[way.rank] || ROAD_STYLE[5];
          ctx.strokeStyle = style.c;
          ctx.lineWidth = style.w;
          ctx.beginPath();
          const n = way.pts.length / 2;
          for (let i = 0; i < n; i++) {
            const x = (way.pts[i * 2] - px) * scale;
            const z = (way.pts[i * 2 + 1] - pz) * scale;
            if (i === 0) ctx.moveTo(x, z);
            else ctx.lineTo(x, z);
          }
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // fleche du joueur, toujours au centre et pointee vers le haut
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = '#8ef04a';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
}

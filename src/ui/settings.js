// Panneau de reglages, commun au clavier et au tactile.
//
// Deux sections : le vehicule et la qualite graphique. Tout s'applique a chaud —
// on ne demande jamais de recharger la page, ce qui ferait perdre la position.

import { VEHICLES } from '../vehicle/catalogue.js';
import { PRESETS } from '../core/device.js';

const STAT_LABELS = {
  puissance: 'Puissance',
  tenue: 'Tenue de route',
  agilite: 'Agilite',
  tout_terrain: 'Tout-terrain',
};

export class Settings {
  constructor(root, { onVehicle, onQuality, onAssists, onDetail, getState }) {
    this.root = root;
    this.onVehicle = onVehicle;
    this.onQuality = onQuality;
    this.onAssists = onAssists;
    this.onDetail = onDetail;
    this.getState = getState;

    root.innerHTML = `
      <div class="settings-panel">
        <header class="settings-head">
          <h2>Reglages</h2>
          <button class="settings-close" data-close aria-label="Fermer">&times;</button>
        </header>

        <div class="settings-body">
          <section>
            <h3>Vehicule</h3>
            <div class="vehicle-grid" data-vehicles></div>
          </section>

          <section>
            <h3>Qualite graphique</h3>
            <div class="preset-row" data-presets></div>
            <p class="settings-note" data-quality-note></p>

            <div class="detail-row">
              <button class="toggle" data-detail="buildings">
                <span>Batiments</span><b data-detail-buildings>—</b>
              </button>
              <button class="toggle" data-detail="vegetation">
                <span>Vegetation</span><b data-detail-vegetation>—</b>
              </button>
            </div>
            <p class="settings-note">
              Ce sont les deux postes les plus lourds, et ceux qui changent le plus
              l'image. Les regler a la main remplace le choix du preset ; en
              reselectionner un remet tout d'aplomb.
            </p>
          </section>

          <section>
            <h3>Aides a la conduite</h3>
            <button class="toggle" data-assists>
              <span>ABS et antipatinage</span><b data-assists-state>—</b>
            </button>
            <p class="settings-note">
              Desactivees, la voiture patine a l'acceleration et bloque ses roues au
              freinage. Plus exigeant, et plus permissif sur les travers.
            </p>
          </section>
        </div>
      </div>
    `;

    this.vehiclesEl = root.querySelector('[data-vehicles]');
    this.presetsEl = root.querySelector('[data-presets]');
    this.noteEl = root.querySelector('[data-quality-note]');
    this.assistsStateEl = root.querySelector('[data-assists-state]');

    this._buildVehicles();
    this._buildPresets();

    root.addEventListener('click', (e) => {
      if (e.target === root || e.target.closest('[data-close]')) this.close();
    });
    root.querySelector('[data-assists]').addEventListener('click', () => {
      this.onAssists();
      this.refresh();
    });
    for (const btn of root.querySelectorAll('[data-detail]')) {
      btn.addEventListener('click', () => {
        const name = btn.dataset.detail;
        this.onDetail(name, !this.getState()[name]);
        this.refresh();
      });
    }
  }

  _buildVehicles() {
    for (const v of VEHICLES) {
      const card = document.createElement('button');
      card.className = 'vehicle-card';
      card.dataset.vehicle = v.id;
      card.innerHTML = `
        <span class="vehicle-swatch" style="background:#${v.colour.toString(16).padStart(6, '0')}"></span>
        <span class="vehicle-name">${v.name}</span>
        <span class="vehicle-tagline">${v.tagline}</span>
        <span class="vehicle-stats">
          ${Object.entries(v.stats)
            .map(
              ([k, n]) => `
            <span class="stat">
              <span class="stat-label">${STAT_LABELS[k] || k}</span>
              <span class="stat-bar">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(5 - n)}</span>
            </span>`
            )
            .join('')}
        </span>
        <span class="vehicle-desc">${v.description}</span>
      `;
      card.addEventListener('click', () => {
        this.onVehicle(v.id);
        this.refresh();
      });
      this.vehiclesEl.appendChild(card);
    }
  }

  _buildPresets() {
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.dataset.preset = p.id;
      btn.innerHTML = `<strong>${p.name}</strong><span>${p.hint}</span>`;
      btn.addEventListener('click', () => {
        this.onQuality(p.id);
        this.refresh();
      });
      this.presetsEl.appendChild(btn);
    }
  }

  refresh() {
    const s = this.getState();
    for (const el of this.vehiclesEl.children) {
      el.classList.toggle('active', el.dataset.vehicle === s.vehicleId);
    }
    for (const el of this.presetsEl.children) {
      el.classList.toggle('active', el.dataset.preset === s.preset);
    }
    // Toujours annoncer les consequences concretes : c'est ce qui donne du poids
    // au choix, bien plus qu'un simple nom de niveau.
    const prefix =
      s.preset === 'auto' ? `« ${labelOf(s.resolved)} » retenu pour cet appareil — ` : '';
    this.noteEl.textContent = prefix + detailOf(s.quality);
    this.assistsStateEl.textContent = s.assists ? 'activees' : 'desactivees';
    this.assistsStateEl.classList.toggle('off', !s.assists);

    for (const name of ['buildings', 'vegetation']) {
      const el = this.root.querySelector('[data-detail-' + name + ']');
      el.textContent = s[name] ? 'affiches' : 'masques';
      el.classList.toggle('off', !s[name]);
    }
  }

  get isOpen() {
    return this.root.classList.contains('visible');
  }
  open() {
    this.refresh();
    this.root.classList.add('visible');
  }
  close() {
    this.root.classList.remove('visible');
  }
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}

const labelOf = (id) => (PRESETS.find((p) => p.id === id) || {}).name || id;

function detailOf(q) {
  const bits = [
    `portee ${(q.terrainRadius * 1.49).toFixed(1)} km`,
    `imagerie ${(3.4 / Math.pow(2, q.imageryBoost)).toFixed(1)} m/pixel`,
    q.shadows ? 'ombres' : 'sans ombres',
    `resolution x${q.pixelRatio.toFixed(2)}`,
    `physique ${Math.round(1 / q.substep)} Hz`,
  ];
  return bits.join(' · ');
}

// Selecteur de destination : carte Leaflet plein ecran, recherche Nominatim,
// quelques routes de legende en acces direct.

const PRESETS = [
  { name: 'Col de Turini', lat: 43.9819, lon: 7.3862, hint: 'Alpes-Maritimes' },
  { name: 'Route des Cretes', lat: 43.1741, lon: 5.7295, hint: 'Cassis - La Ciotat' },
  { name: 'Stelvio', lat: 46.5286, lon: 10.4541, hint: 'Italie' },
  { name: 'Nordschleife', lat: 50.3356, lon: 6.9475, hint: 'Eifel' },
  { name: 'Monaco', lat: 43.7347, lon: 7.4206, hint: 'Principaute' },
  { name: 'Lombard Street', lat: 37.8021, lon: -122.4187, hint: 'San Francisco' },
  { name: 'Grossglockner', lat: 47.0839, lon: 12.8306, hint: 'Autriche' },
  { name: 'Route de Combe Laval', lat: 45.0339, lon: 5.3535, hint: 'Vercors' },
];

export class Picker {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.selection = null;

    root.innerHTML = `
      <div class="picker-panel">
        <header>
          <h1>Ou veux-tu rouler&nbsp;?</h1>
          <p>Cherche un lieu, clique sur la carte, puis lance-toi. Le monde est genere
             a partir du relief reel et du trace exact des routes.</p>
        </header>
        <div class="picker-search">
          <input type="search" placeholder="Ville, col, adresse..." data-search autocomplete="off">
          <button data-search-btn>Chercher</button>
        </div>
        <div class="picker-results" data-results></div>
        <div class="picker-presets" data-presets></div>
        <div class="picker-go">
          <div class="picker-coords" data-coords>Aucun point selectionne</div>
          <button class="primary" data-go disabled>Rouler ici</button>
        </div>
      </div>
      <div class="picker-map" data-map></div>
    `;

    this.searchInput = root.querySelector('[data-search]');
    this.resultsEl = root.querySelector('[data-results]');
    this.coordsEl = root.querySelector('[data-coords]');
    this.goBtn = root.querySelector('[data-go]');

    this._buildPresets(root.querySelector('[data-presets]'));
    this._buildMap(root.querySelector('[data-map]'));

    root.querySelector('[data-search-btn]').addEventListener('click', () => this._search());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._search();
    });
    this.goBtn.addEventListener('click', () => {
      if (this.selection) this.onPick(this.selection);
    });
  }

  show() {
    this.root.classList.add('visible');
    setTimeout(() => this.map.invalidateSize(), 60);
  }
  hide() {
    this.root.classList.remove('visible');
  }

  _buildMap(el) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([43.53, 5.45], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; contributeurs OpenStreetMap',
    }).addTo(this.map);
    this.marker = null;
    this.map.on('click', (e) => this._select(e.latlng.lat, e.latlng.lng));
  }

  _buildPresets(el) {
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.innerHTML = `<strong>${p.name}</strong><span>${p.hint}</span>`;
      btn.addEventListener('click', () => {
        this.map.setView([p.lat, p.lon], 14);
        this._select(p.lat, p.lon, p.name);
      });
      el.appendChild(btn);
    }
  }

  _select(lat, lon, name = null) {
    this.selection = { lat, lon, name };
    if (!this.marker) this.marker = L.marker([lat, lon]).addTo(this.map);
    else this.marker.setLatLng([lat, lon]);
    this.coordsEl.textContent =
      (name ? name + ' — ' : '') + lat.toFixed(5) + ', ' + lon.toFixed(5);
    this.goBtn.disabled = false;
  }

  async _search() {
    const q = this.searchInput.value.trim();
    if (!q) return;
    this.resultsEl.innerHTML = '<div class="muted">Recherche...</div>';
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' +
        encodeURIComponent(q);
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      if (!list.length) {
        this.resultsEl.innerHTML = '<div class="muted">Aucun resultat.</div>';
        return;
      }
      this.resultsEl.innerHTML = '';
      for (const item of list) {
        const btn = document.createElement('button');
        btn.className = 'result';
        btn.textContent = item.display_name;
        btn.addEventListener('click', () => {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          this.map.setView([lat, lon], 15);
          this._select(lat, lon, item.display_name.split(',')[0]);
        });
        this.resultsEl.appendChild(btn);
      }
    } catch (err) {
      this.resultsEl.innerHTML =
        '<div class="muted">Recherche indisponible. Clique directement sur la carte.</div>';
    }
  }
}

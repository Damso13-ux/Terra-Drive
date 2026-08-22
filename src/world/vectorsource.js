// Source de donnees en tuiles vectorielles (PMTiles + Mapbox Vector Tile).
//
// Remplace Overpass quand une archive est configuree : pas de quota, une seule
// requete de plage par tuile, servie par un CDN. C'est la meme donnee
// OpenStreetMap, simplement pre-decoupee.
//
// Le point important de ce module : il rend des elements ayant EXACTEMENT la
// meme forme qu'une reponse Overpass ({ type, id, tags, geometry }). Tout le
// reste du jeu ignore donc completement d'ou vient la donnee — routes,
// batiments et vegetation n'ont pas eu a changer d'une ligne.

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

import { TILES_ZOOM } from '../config.js';

/** Conversions lon/lat <-> indices de tuile slippy. */
const lonToTile = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
const latToTile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
};

export class VectorSource {
  constructor(url, { zoom = TILES_ZOOM } = {}) {
    this.url = url;
    this.zoom = zoom;
    this.archive = new PMTiles(url);
    this.ready = null;
    /** Une tuile n'est livree qu'une fois : nos cellules et les tuiles ne
     *  coincident pas, et deux cellules voisines partagent des tuiles. */
    this.emitted = new Set();
    this.stats = { tiles: 0, features: 0, failed: 0 };
  }

  /** Verifie que l'archive repond et couvre bien le zoom demande. */
  async available() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        const header = await this.archive.getHeader();
        this.minZoom = header.minZoom;
        this.maxZoom = header.maxZoom;
        if (this.zoom > header.maxZoom) this.zoom = header.maxZoom;
        return true;
      } catch (err) {
        this.stats.failed++;
        return false;
      }
    })();
    return this.ready;
  }

  /**
   * Elements couvrant une cellule, au format d'une reponse Overpass.
   * @param bounds {west, south, east, north}
   */
  async fetchCell(bounds) {
    const z = this.zoom;
    const x0 = Math.floor(lonToTile(bounds.west, z));
    const x1 = Math.floor(lonToTile(bounds.east, z));
    const y0 = Math.floor(latToTile(bounds.north, z));
    const y1 = Math.floor(latToTile(bounds.south, z));

    const out = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = z + '/' + x + '/' + y;
        if (this.emitted.has(key)) continue;
        this.emitted.add(key);
        try {
          await this._readTile(z, x, y, out);
        } catch {
          this.stats.failed++;
          this.emitted.delete(key); // on pourra retenter
        }
      }
    }
    this.stats.features += out.length;
    return out;
  }

  async _readTile(z, x, y, out) {
    const res = await this.archive.getZxy(z, x, y);
    if (!res || !res.data) return; // tuile absente : zone sans donnee
    this.stats.tiles++;

    const tile = new VectorTile(new Pbf(res.data));
    for (const layerName of Object.keys(tile.layers)) {
      const mapper = LAYERS[layerName];
      if (!mapper) continue;
      const layer = tile.layers[layerName];

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const tags = mapper(feature.properties || {});
        if (!tags) continue;

        const geo = feature.toGeoJSON(x, y, z);
        for (const ring of ringsOf(geo)) {
          if (ring.length < 2) continue;
          out.push({
            type: 'way',
            // Les entites sont decoupees a la frontiere des tuiles : un meme
            // identifiant peut donc revenir dans deux tuiles voisines pour deux
            // moities distinctes. On le combine avec la tuile pour que les deux
            // survivent au dedoublonnage.
            id: mix(feature.id || i, x, y),
            tags,
            geometry: ring.map((c) => ({ lon: c[0], lat: c[1] })),
          });
        }
      }
    }
  }
}

/** Anneaux exterieurs d'une geometrie GeoJSON, sous forme de listes de points. */
export function ringsOf(geo) {
  const g = geo.geometry;
  switch (g.type) {
    case 'LineString':
      return [g.coordinates];
    case 'MultiLineString':
      return g.coordinates;
    case 'Polygon':
      return [g.coordinates[0]]; // contour exterieur seul : les cours interieures
    case 'MultiPolygon': //          ne changent rien a ce qu'on en fait
      return g.coordinates.map((poly) => poly[0]);
    default:
      return [];
  }
}

/** Melange stable d'un identifiant et d'une tuile, en entier 31 bits. */
function mix(id, x, y) {
  let h = (id >>> 0) ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return (h ^ (h >>> 13)) & 0x7fffffff;
}

/**
 * Traduction du schema Protomaps vers les tags OpenStreetMap d'origine.
 *
 * Le schema conserve la valeur OSM complete dans `kind` (motorway, track,
 * residential...), ce qui permet de garder telles quelles les familles de route.
 * Sont en revanche perdus `surface`, `smoothness`, `lanes` et `width` : une
 * departementale en gravier passera pour une route revetue. C'est le prix de la
 * generalisation, et il reste modeste.
 */
export const LAYERS = {
  roads: (p) => {
    if (!p.kind) return null;
    const tags = { highway: p.kind };
    if (p.name) tags.name = p.name;
    if (p.is_bridge) tags.bridge = 'yes';
    if (p.is_tunnel) tags.tunnel = 'yes';
    if (p.ref) tags.ref = p.ref;
    return tags;
  },

  buildings: (p) => {
    const tags = { building: p.kind || 'yes' };
    if (Number.isFinite(p.height)) tags.height = String(p.height);
    if (Number.isFinite(p.min_height)) tags.min_height = String(p.min_height);
    return tags;
  },

  landuse: (p) => (p.kind ? { landuse: p.kind } : null),
  natural: (p) => (p.kind ? { natural: p.kind } : null),
};

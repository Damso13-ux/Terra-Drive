// Web-Mercator helpers + a local metric frame ("ENU-ish") anchored on a spawn point.
// Convention three.js : X = est, Y = haut (altitude reelle en metres), Z = sud.

export const EARTH_R = 6378137;
export const ORIGIN_SHIFT = Math.PI * EARTH_R; // 20037508.342789244
export const TILE_PX = 256;
export const DEG = Math.PI / 180;

export const lonToMercX = (lon) => (lon * ORIGIN_SHIFT) / 180;
export const latToMercY = (lat) =>
  (Math.log(Math.tan((90 + lat) * Math.PI / 360)) / DEG) * ORIGIN_SHIFT / 180;
export const mercXToLon = (x) => (x * 180) / ORIGIN_SHIFT;
export const mercYToLat = (y) =>
  (180 / Math.PI) * (2 * Math.atan(Math.exp(((y * 180) / ORIGIN_SHIFT) * DEG)) - Math.PI / 2);

/** Taille d'un pixel (en metres mercator) au zoom donne. */
export const resolution = (zoom) => (2 * ORIGIN_SHIFT) / (TILE_PX * Math.pow(2, zoom));

/**
 * Repere local metrique. Le mercator dilate les distances d'un facteur 1/cos(lat) ;
 * on remultiplie par cos(lat0) pour que 1 unite three.js == 1 metre au sol.
 */
export class Projection {
  constructor(lon0, lat0) {
    this.lon0 = lon0;
    this.lat0 = lat0;
    this.mx0 = lonToMercX(lon0);
    this.my0 = latToMercY(lat0);
    this.k = Math.cos(lat0 * DEG); // mercator -> sol
    this.invK = 1 / this.k;
  }

  /** lon/lat -> [x, z] monde (metres) */
  toWorld(lon, lat, out = [0, 0]) {
    out[0] = (lonToMercX(lon) - this.mx0) * this.k;
    out[1] = -(latToMercY(lat) - this.my0) * this.k;
    return out;
  }

  /** [x, z] monde -> {lon, lat} */
  toLonLat(x, z) {
    return {
      lon: mercXToLon(this.mx0 + x * this.invK),
      lat: mercYToLat(this.my0 - z * this.invK),
    };
  }

  /** x monde -> coordonnee pixel globale (float) au zoom donne */
  worldToPixelX(x, zoom) {
    return (this.mx0 + x * this.invK + ORIGIN_SHIFT) / resolution(zoom);
  }
  worldToPixelY(z, zoom) {
    return (ORIGIN_SHIFT - (this.my0 - z * this.invK)) / resolution(zoom);
  }
  pixelXToWorld(px, zoom) {
    return (px * resolution(zoom) - ORIGIN_SHIFT - this.mx0) * this.k;
  }
  pixelYToWorld(py, zoom) {
    return -((ORIGIN_SHIFT - py * resolution(zoom)) - this.my0) * this.k;
  }

  /** Metres au sol par pixel de tuile a ce zoom, a la latitude d'origine. */
  metersPerPixel(zoom) {
    return resolution(zoom) * this.k;
  }
}

/** lon/lat -> indices de tuile slippy */
export function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = lat * DEG;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x: clampTile(x, n), y: clampTile(y, n) };
}

const clampTile = (v, n) => Math.max(0, Math.min(n - 1, v));

/** Bounding box lon/lat d'une tuile slippy. */
export function tileBounds(tx, ty, zoom) {
  const n = Math.pow(2, zoom);
  const lon0 = (tx / n) * 360 - 180;
  const lon1 = ((tx + 1) / n) * 360 - 180;
  const lat = (yy) => {
    const t = Math.PI - (2 * Math.PI * yy) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  return { west: lon0, east: lon1, north: lat(ty), south: lat(ty + 1) };
}

// Grille de cellules ANCRÉE SUR LE MONDE, pas sur le point de depart.
//
// Les cellules etaient jusqu'ici decoupees en metres depuis l'origine locale, ce
// qui rendait tout cache inutile : deux departs distants de 300 m dans la meme
// ville ne partageaient plus aucune cellule, donc plus aucune donnee.
//
// Le decoupage se fait desormais en coordonnees Web-Mercator absolues. Une
// cellule a la meme identite pour tout le monde, a tout moment : on peut la
// mettre en cache, la nommer, la partager.

import { mercXToLon, mercYToLat } from '../core/geo.js';

/** Cote d'une cellule, en metres mercator. Au sol : x cos(latitude). */
export const CELL_MERC = 2048;

/** Indices de cellule pour un point du repere local. */
export function cellOfWorld(proj, x, z) {
  const mercX = proj.mx0 + x * proj.invK;
  const mercY = proj.my0 - z * proj.invK;
  return {
    cx: Math.floor(mercX / CELL_MERC),
    cz: Math.floor(-mercY / CELL_MERC),
  };
}

export function cellKey(cx, cz) {
  return cx + ',' + cz;
}

/** Emprise geographique d'une cellule, pour interroger Overpass. */
export function cellBoundsLonLat(cx, cz) {
  return {
    west: mercXToLon(cx * CELL_MERC),
    east: mercXToLon((cx + 1) * CELL_MERC),
    north: mercYToLat(-cz * CELL_MERC),
    south: mercYToLat(-(cz + 1) * CELL_MERC),
  };
}

/** Emprise de la cellule dans le repere local. */
export function cellRectWorld(proj, cx, cz) {
  const x0 = (cx * CELL_MERC - proj.mx0) * proj.k;
  const x1 = ((cx + 1) * CELL_MERC - proj.mx0) * proj.k;
  const z0 = -(-cz * CELL_MERC - proj.my0) * proj.k;
  const z1 = -(-(cz + 1) * CELL_MERC - proj.my0) * proj.k;
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1),
    maxZ: Math.max(z0, z1),
  };
}

/** Cote d'une cellule au sol, en metres, a la latitude courante. */
export function cellSizeMetres(proj) {
  return CELL_MERC * proj.k;
}

/**
 * Cellules couvrant un disque, triees par distance croissante au centre :
 * ce qui est proche doit arriver en premier.
 */
export function cellsAround(proj, worldX, worldZ, radiusCells) {
  const { cx, cz } = cellOfWorld(proj, worldX, worldZ);
  const out = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const rect = cellRectWorld(proj, cx + dx, cz + dz);
      const midX = (rect.minX + rect.maxX) / 2;
      const midZ = (rect.minZ + rect.maxZ) / 2;
      out.push({
        cx: cx + dx,
        cz: cz + dz,
        key: cellKey(cx + dx, cz + dz),
        rect,
        distance: Math.hypot(midX - worldX, midZ - worldZ),
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

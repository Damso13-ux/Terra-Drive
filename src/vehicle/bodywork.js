// Geometrie de carrosserie.
//
// La caisse etait un empilement de boites : silhouette impossible, aretes vives
// partout. Elle est desormais lissee entre des SECTIONS — une suite de contours
// places le long de la voiture, reliees entre elles. C'est ainsi que se dessine
// une carrosserie : quelques stations bien choisies, et la surface suit.
//
// Chaque contour est un rectangle a coins arrondis (superellipse) : un seul
// parametre fait passer d'un pave a une forme galbee, et les aretes s'adoucissent
// toutes seules — sans avoir a modeliser le moindre conge.

import * as THREE from 'three';

/**
 * Contour d'une section, echantillonne sur `n` points.
 *
 * @param halfW demi-largeur
 * @param yLow  bas de la section
 * @param yHigh haut de la section
 * @param round 2 = ellipse pure, 8 = quasi rectangulaire. 4 a 5 pour une caisse.
 */
function outline(halfW, yLow, yHigh, n, round, isOpen, houseHalfW) {
  const cy = (yLow + yHigh) / 2;
  const halfH = (yHigh - yLow) / 2;
  const pts = [];
  const e = 2 / round;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x = Math.sign(c) * Math.pow(Math.abs(c), e) * halfW;
    const y = cy + Math.sign(s) * Math.pow(Math.abs(s), e) * halfH;
    // Creusement du passage de roue : dans l'ouverture, le flanc rentre jusqu'a
    // la paroi du logement. C'est ce qui fait un vrai creux d'aile, la ou un
    // anneau pose par-dessus ne trompe personne.
    if (isOpen !== null && isOpen(y) && Math.abs(x) > houseHalfW) {
      x = Math.sign(x) * houseHalfW;
    }
    pts.push(x, y);
  }
  return pts;
}

/**
 * Densifie une suite de sections par interpolation lineaire.
 *
 * Indispensable avant de creuser : avec huit sections sur toute la longueur,
 * une arche tomberait entre deux et produirait une marche au lieu d'un arrondi.
 */
export function densify(stations, count) {
  const z0 = stations[0].z;
  const z1 = stations[stations.length - 1].z;
  const out = [];
  for (let i = 0; i < count; i++) {
    const z = z0 + ((z1 - z0) * i) / (count - 1);
    let k = 0;
    while (k < stations.length - 2 && stations[k + 1].z < z) k++;
    const a = stations[k];
    const b = stations[k + 1];
    const t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
    const mix = (u, v) => u + (v - u) * t;
    out.push({
      z,
      halfW: mix(a.halfW, b.halfW),
      yLow: mix(a.yLow, b.yLow),
      yHigh: mix(a.yHigh, b.yHigh),
      round: mix(a.round ?? 3.6, b.round ?? 3.6),
    });
  }
  return out;
}

/**
 * Relie une suite de sections en une surface fermee.
 *
 * @param stations [{ z, halfW, yLow, yHigh, round }]
 * @param segments points par contour
 */
export function loft(stations, segments = 22, wells = null) {
  const rings = stations.map((s) => {
    let isOpen = null;
    if (wells) {
      const near = [];
      for (const w of wells.wheels) {
        const d = Math.abs(s.z - w.z);
        if (d < w.radius) near.push({ d, y: w.y, r: w.radius });
      }
      if (near.length) {
        // Contour de l'ouverture d'aile : demi-cercle au-dessus du moyeu, puis
        // deux bords presque verticaux qui redescendent au bas de caisse.
        //
        // Creuser tout ce qui est sous la ligne d'arche — reflexe naturel —
        // evide aussi les zones situees devant et derriere le pneu, la ou rien
        // ne vient remplir le trou : la voiture se retrouve flanquee de deux
        // croissants noirs.
        isOpen = (y) =>
          near.some((w) => {
            const dy = y - w.y;
            return dy >= 0
              ? w.d * w.d + dy * dy < w.r * w.r
              : w.d < w.r * 0.84;
          });
      }
    }
    return outline(
      s.halfW,
      s.yLow,
      s.yHigh,
      segments,
      s.round ?? 3.6,
      isOpen,
      wells ? wells.houseHalfW : 0
    );
  });

  const positions = [];
  const push = (ring, i, z) => positions.push(ring[i * 2], ring[i * 2 + 1], z);

  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    const za = stations[k].z;
    const zb = stations[k + 1].z;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      // Deux triangles par facette. L'ORDRE COMPTE : les contours sont
      // parcourus dans le sens trigonometrique et z croit vers l'arriere, si
      // bien que l'enroulement naif sort une normale vers l'INTERIEUR. La face
      // exterieure est alors eliminee et l'on voit l'interieur du flanc oppose
      // — la carrosserie parait translucide.
      push(a, i, za); push(b, j, zb); push(b, i, zb);
      push(a, i, za); push(a, j, za); push(b, j, zb);
    }
  }

  // bouchons avant et arriere, en eventail depuis le centre
  const cap = (ring, z, reverse) => {
    let cx = 0, cy = 0;
    for (let i = 0; i < segments; i++) { cx += ring[i * 2]; cy += ring[i * 2 + 1]; }
    cx /= segments; cy /= segments;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      if (reverse) {
        positions.push(cx, cy, z); push(ring, j, z); push(ring, i, z);
      } else {
        positions.push(cx, cy, z); push(ring, i, z); push(ring, j, z);
      }
    }
  };
  // les bouchons suivent le meme sens que les flancs
  cap(rings[0], stations[0].z, false);
  cap(rings[rings.length - 1], stations[stations.length - 1].z, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Silhouettes, en fractions des dimensions du vehicule.
 *
 * z va de -0.5 (nez) a +0.5 (poupe), les hauteurs sont relatives a la hauteur
 * de caisse. Une station = une coupe transversale ; c'est tout ce qu'il faut
 * pour differencier une citadine d'un pick-up.
 */
export const SHAPES = {
  citadine: {
    body: [
      { z: -0.50, halfW: 0.40, yLow: 0.32, yHigh: 0.52 },
      { z: -0.45, halfW: 0.47, yLow: 0.25, yHigh: 0.56 },
      { z: -0.36, halfW: 0.50, yLow: 0.22, yHigh: 0.59 },
      { z: -0.18, halfW: 0.51, yLow: 0.21, yHigh: 0.63 },
      { z: 0.04, halfW: 0.51, yLow: 0.21, yHigh: 0.64 },
      { z: 0.28, halfW: 0.50, yLow: 0.22, yHigh: 0.64 },
      { z: 0.44, halfW: 0.46, yLow: 0.26, yHigh: 0.62 },
      { z: 0.485, halfW: 0.37, yLow: 0.31, yHigh: 0.58 },
      { z: 0.50, halfW: 0.28, yLow: 0.35, yHigh: 0.54 },
    ],
    // habitacle avance et haut : c'est la signature d'une citadine
    cabin: [
      { z: -0.20, halfW: 0.38, yLow: 0.61, yHigh: 0.66, round: 3.4 },
      { z: -0.08, halfW: 0.45, yLow: 0.61, yHigh: 0.92, round: 4.0 },
      { z: 0.08, halfW: 0.46, yLow: 0.61, yHigh: 1.00, round: 4.0 },
      { z: 0.26, halfW: 0.45, yLow: 0.61, yHigh: 0.97, round: 3.8 },
      { z: 0.38, halfW: 0.39, yLow: 0.61, yHigh: 0.76, round: 3.4 },
    ],
  },

  berline: {
    body: [
      { z: -0.50, halfW: 0.40, yLow: 0.30, yHigh: 0.46 },
      { z: -0.46, halfW: 0.47, yLow: 0.24, yHigh: 0.50 },
      { z: -0.36, halfW: 0.50, yLow: 0.21, yHigh: 0.53 },
      { z: -0.20, halfW: 0.51, yLow: 0.20, yHigh: 0.56 },
      { z: 0.00, halfW: 0.51, yLow: 0.20, yHigh: 0.58 },
      { z: 0.22, halfW: 0.50, yLow: 0.20, yHigh: 0.58 },
      { z: 0.40, halfW: 0.47, yLow: 0.23, yHigh: 0.55 },
      { z: 0.485, halfW: 0.38, yLow: 0.27, yHigh: 0.50 },
      { z: 0.50, halfW: 0.29, yLow: 0.31, yHigh: 0.46 },
    ],
    cabin: [
      { z: -0.14, halfW: 0.38, yLow: 0.55, yHigh: 0.60, round: 3.2 },
      { z: -0.02, halfW: 0.45, yLow: 0.55, yHigh: 0.86, round: 4.0 },
      { z: 0.12, halfW: 0.46, yLow: 0.55, yHigh: 0.95, round: 4.0 },
      { z: 0.24, halfW: 0.45, yLow: 0.55, yHigh: 0.90, round: 3.8 },
      { z: 0.34, halfW: 0.38, yLow: 0.55, yHigh: 0.66, round: 3.2 },
    ],
  },

  gt: {
    body: [
      { z: -0.50, halfW: 0.42, yLow: 0.28, yHigh: 0.42 },
      { z: -0.45, halfW: 0.49, yLow: 0.21, yHigh: 0.47 },
      { z: -0.34, halfW: 0.51, yLow: 0.19, yHigh: 0.52 },
      { z: -0.16, halfW: 0.52, yLow: 0.18, yHigh: 0.58 },
      { z: 0.06, halfW: 0.52, yLow: 0.18, yHigh: 0.62 },
      { z: 0.28, halfW: 0.51, yLow: 0.19, yHigh: 0.62 },
      { z: 0.44, halfW: 0.47, yLow: 0.21, yHigh: 0.58 },
      { z: 0.485, halfW: 0.39, yLow: 0.24, yHigh: 0.53 },
      { z: 0.50, halfW: 0.30, yLow: 0.28, yHigh: 0.49 },
    ],
    // pavillon recule et ecrase : le profil d'un coupe
    cabin: [
      { z: -0.06, halfW: 0.38, yLow: 0.60, yHigh: 0.65, round: 3.2 },
      { z: 0.06, halfW: 0.44, yLow: 0.60, yHigh: 0.88, round: 4.2 },
      { z: 0.20, halfW: 0.44, yLow: 0.60, yHigh: 0.92, round: 4.2 },
      { z: 0.36, halfW: 0.40, yLow: 0.60, yHigh: 0.72, round: 3.4 },
    ],
  },

  rallye: {
    body: [
      { z: -0.50, halfW: 0.41, yLow: 0.35, yHigh: 0.54 },
      { z: -0.45, halfW: 0.48, yLow: 0.27, yHigh: 0.58 },
      { z: -0.35, halfW: 0.51, yLow: 0.24, yHigh: 0.61 },
      { z: -0.16, halfW: 0.52, yLow: 0.23, yHigh: 0.65 },
      { z: 0.06, halfW: 0.52, yLow: 0.23, yHigh: 0.66 },
      { z: 0.30, halfW: 0.51, yLow: 0.24, yHigh: 0.66 },
      { z: 0.44, halfW: 0.47, yLow: 0.28, yHigh: 0.64 },
      { z: 0.485, halfW: 0.38, yLow: 0.33, yHigh: 0.60 },
      { z: 0.50, halfW: 0.29, yLow: 0.37, yHigh: 0.56 },
    ],
    cabin: [
      { z: -0.18, halfW: 0.40, yLow: 0.63, yHigh: 0.68, round: 3.4 },
      { z: -0.06, halfW: 0.47, yLow: 0.63, yHigh: 0.94, round: 4.0 },
      { z: 0.12, halfW: 0.48, yLow: 0.63, yHigh: 1.01, round: 4.0 },
      { z: 0.30, halfW: 0.47, yLow: 0.63, yHigh: 0.98, round: 3.8 },
      { z: 0.42, halfW: 0.40, yLow: 0.63, yHigh: 0.78, round: 3.4 },
    ],
  },

  pickup: {
    body: [
      { z: -0.50, halfW: 0.41, yLow: 0.33, yHigh: 0.52 },
      { z: -0.45, halfW: 0.48, yLow: 0.26, yHigh: 0.56 },
      { z: -0.36, halfW: 0.51, yLow: 0.24, yHigh: 0.59 },
      { z: -0.20, halfW: 0.52, yLow: 0.24, yHigh: 0.61 },
      { z: 0.00, halfW: 0.52, yLow: 0.24, yHigh: 0.61 },
      // la benne : ridelles plus hautes que le capot
      { z: 0.08, halfW: 0.52, yLow: 0.24, yHigh: 0.66 },
      { z: 0.44, halfW: 0.51, yLow: 0.25, yHigh: 0.66 },
      { z: 0.50, halfW: 0.43, yLow: 0.29, yHigh: 0.64 },
    ],
    // cabine courte, tres en avant : tout l'arriere est la benne
    cabin: [
      { z: -0.26, halfW: 0.40, yLow: 0.60, yHigh: 0.65, round: 3.2 },
      { z: -0.16, halfW: 0.47, yLow: 0.60, yHigh: 0.94, round: 3.8 },
      { z: -0.02, halfW: 0.48, yLow: 0.60, yHigh: 1.00, round: 3.8 },
      { z: 0.06, halfW: 0.47, yLow: 0.60, yHigh: 0.96, round: 3.6 },
    ],
  },
};

/**
 * Met a l'echelle des stations exprimees en fractions.
 *
 * Les hauteurs des silhouettes sont mesurees DEPUIS LE SOL — c'est la seule
 * facon lisible de dessiner une voiture. Or le repere du vehicule a son origine
 * au centre de gravite : sans le decalage, la caisse flotte au-dessus des roues.
 *
 * @param yOffset hauteur du centre de gravite au-dessus du sol, en metres
 */
export function scaleStations(stations, length, width, height, yOffset = 0) {
  return stations.map((s) => ({
    z: s.z * length,
    halfW: s.halfW * width,
    yLow: s.yLow * height - yOffset,
    yHigh: s.yHigh * height - yOffset,
    round: s.round,
  }));
}

/**
 * Pavillon, deduit des sections de l'habitacle.
 *
 * Sans lui, l'habitacle est vitre du bas de caisse jusqu'au sommet et se lit
 * comme une bulle de plexiglas. Sur une voiture, le toit est peint : seules les
 * vitres sont transparentes. C'est ce contraste qui fait lire la silhouette.
 *
 * On ne garde que les sections proches du point haut — celles qui portent
 * reellement le toit — et on les rabaisse en une calotte mince.
 */
export function roofFromCabin(cabin) {
  let peak = 0;
  for (const s of cabin) peak = Math.max(peak, s.yHigh);
  const floor = peak * 0.88;

  const kept = cabin.filter((s) => s.yHigh > floor);
  if (kept.length < 2) return null;

  return kept.map((s) => ({
    z: s.z,
    halfW: s.halfW * 0.985,
    yLow: floor,
    yHigh: s.yHigh * 1.004, // affleure le vitrage, sans le percer
    round: 4.4,
  }));
}

/**
 * Roue complete : pneu a flancs arrondis, jante a rayons, disque de frein.
 *
 * Le pneu est un profil tourne : c'est ce qui donne l'epaule arrondie, qu'un
 * simple cylindre ne saura jamais rendre — et c'est la premiere chose qu'on voit
 * d'une voiture au ras du sol.
 */
export function buildWheel(radius, width, spokes = 5) {
  const parts = { tyre: null, rim: null, disc: null };

  // --- pneu : profil tourne autour de l'axe -------------------------------
  const half = width / 2;
  const shoulder = radius * 0.12;
  const profile = [
    new THREE.Vector2(radius * 0.62, -half),
    new THREE.Vector2(radius - shoulder, -half),
    new THREE.Vector2(radius - shoulder * 0.35, -half * 0.86),
    new THREE.Vector2(radius, -half * 0.6),
    new THREE.Vector2(radius, half * 0.6),
    new THREE.Vector2(radius - shoulder * 0.35, half * 0.86),
    new THREE.Vector2(radius - shoulder, half),
    new THREE.Vector2(radius * 0.62, half),
  ];
  const tyre = new THREE.LatheGeometry(profile, 26);
  tyre.rotateZ(Math.PI / 2); // l'axe passe de Y a X
  parts.tyre = tyre;

  // --- jante --------------------------------------------------------------
  //
  // Ordre capital, de l'interieur vers l'exterieur : fond sombre, PUIS rayons.
  // Une face pleine en alliage devant les rayons les masque entierement, et la
  // roue se reduit alors a un disque blanc qui capte toute la lumiere.
  const rimGeos = [];

  const barrel = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.9, 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  rimGeos.push(barrel);

  for (let i = 0; i < spokes; i++) {
    const spoke = new THREE.BoxGeometry(width * 0.1, radius * 0.44, radius * 0.15);
    spoke.translate(0, radius * 0.34, 0);
    spoke.rotateX((i / spokes) * Math.PI * 2 + 0.3);
    spoke.translate(width * 0.36, 0, 0);
    rimGeos.push(spoke);
  }

  const cap = new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, width * 0.12, 14);
  cap.rotateZ(Math.PI / 2);
  cap.translate(width * 0.42, 0, 0);
  rimGeos.push(cap);

  parts.rim = mergeSimple(rimGeos);

  // --- fond de jante et disque de frein -----------------------------------
  // Le fond bouche la roue : sans lui on voit au travers, et les rayons se
  // detachent mal.
  const backGeos = [];
  const back = new THREE.CylinderGeometry(radius * 0.61, radius * 0.61, width * 0.05, 22);
  back.rotateZ(Math.PI / 2);
  back.translate(width * 0.24, 0, 0);
  backGeos.push(back);

  const brake = new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, width * 0.08, 18);
  brake.rotateZ(Math.PI / 2);
  brake.translate(-width * 0.05, 0, 0);
  backGeos.push(brake);

  parts.disc = mergeSimple(backGeos);

  return parts;
}

/** Fusion de geometries non indexees : position et normal uniquement. */
export function mergeSimple(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let offset = 0;
  for (const g of parts) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    offset += g.attributes.position.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.computeBoundingSphere();
  return out;
}

// Surface de collision unique vue par la physique : le relief, ecrase par la chaussee
// la ou il y en a une, avec un raccord doux sur les bas-cotes.

// 0.6 transformait le moindre ecart en piege : on quittait la chaussee et la
// voiture devenait incontrolable. Le bas-cote doit penaliser, pas punir.
const OFFROAD_GRIP = 0.8;

export class Ground {
  constructor(heightfield, roads) {
    this.hf = heightfield;
    this.roads = roads;
    this._n = { x: 0, y: 1, z: 0 };
  }

  /** @returns {{y:number, grip:number, onRoad:number}} */
  probe(x, z) {
    const terrain = this.hf.sample(x, z);
    const road = this.roads ? this.roads.queryGround(x, z) : null;
    if (!road) return { y: terrain, grip: OFFROAD_GRIP, onRoad: 0 };
    const b = road.blend;
    return {
      y: terrain + (road.y - terrain) * b,
      grip: OFFROAD_GRIP + (road.grip - OFFROAD_GRIP) * b,
      onRoad: b,
    };
  }

  height(x, z) {
    return this.probe(x, z).y;
  }

  /**
   * Altitude utilisee pour MAILLER le terrain. Le corridor est volontairement plus
   * large et le raccord plus long que pour la physique : le maillage est echantillonne
   * tous les ~14 m, il faut donc un remblai doux pour que la chaussee ne perce pas le sol.
   */
  meshHeight(x, z) {
    const terrain = this.hf.sample(x, z);
    if (!this.roads) return terrain;
    const road = this.roads.queryGround(x, z, 2.5, 11);
    if (!road) return terrain;
    return terrain + (road.y - 0.06 - terrain) * road.blend;
  }

  /** Normale de la surface combinee (la voiture s'incline donc avec le devers). */
  normal(x, z, eps = 1.2) {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    const nx = (hL - hR) / (2 * eps);
    const nz = (hD - hU) / (2 * eps);
    const len = Math.hypot(nx, 1, nz);
    this._n.x = nx / len;
    this._n.y = 1 / len;
    this._n.z = nz / len;
    return this._n;
  }

  /**
   * Intersection d'un rayon avec la surface.
   *
   * C'est le point chaud absolu du moteur : quatre roues, 180 a 240 pas par seconde.
   * Les rayons de suspension sont quasi verticaux, donc on n'utilise pas une
   * bissection aveugle mais un point fixe qui converge en 3 iterations :
   * on suppose le sol plat, on regarde ou on tombe, on recommence. La bissection
   * ne sert que de filet quand la pente est trop forte pour converger.
   *
   * @returns t dans [0, maxT], ou -1 si le rayon ne touche rien
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    if (dy > -0.35) return this._raycastBisection(ox, oy, oz, dx, dy, dz, maxT);

    const invDown = -1 / dy;
    let t = (oy - this.height(ox, oz)) * invDown;
    if (t <= 0) return 0; // deja sous la surface

    for (let i = 0; i < 3; i++) {
      if (t > maxT * 1.6) return -1; // franchement au-dessus du sol, inutile d'affiner
      const h = this.height(ox + dx * t, oz + dz * t);
      const next = (oy - h) * invDown;
      const delta = next - t;
      t = next;
      if (delta > -0.004 && delta < 0.004) break;
    }

    if (t < 0) t = 0;
    if (t > maxT) return -1;

    // Verification : sur une pente raide le point fixe peut osciller. Dans ce cas,
    // on repasse par la methode lente mais infaillible.
    const err = oy + dy * t - this.height(ox + dx * t, oz + dz * t);
    if (err > 0.05 || err < -0.05) {
      return this._raycastBisection(ox, oy, oz, dx, dy, dz, maxT);
    }
    return t;
  }

  _raycastBisection(ox, oy, oz, dx, dy, dz, maxT) {
    const f = (t) => oy + dy * t - this.height(ox + dx * t, oz + dz * t);
    if (f(0) <= 0) return 0;
    const COARSE = 8;
    let prevT = 0;
    for (let i = 1; i <= COARSE; i++) {
      const t = (maxT * i) / COARSE;
      if (f(t) <= 0) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          if (f(mid) > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      prevT = t;
    }
    return -1;
  }
}

// Surface de collision unique vue par la physique : le relief, ecrase par la chaussee
// la ou il y en a une, avec un raccord doux sur les bas-cotes.

const OFFROAD_GRIP = 0.6;

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
   * Intersection d'un rayon avec la surface (bissection : la surface est un
   * champ de hauteur, donc h(t) - y(t) change de signe une seule fois en pratique).
   * @returns t dans [0, maxT] ou -1
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    const f = (t) => oy + dy * t - this.height(ox + dx * t, oz + dz * t);
    let f0 = f(0);
    if (f0 <= 0) return 0; // deja sous la surface
    const COARSE = 8;
    let prevT = 0;
    let prevF = f0;
    for (let i = 1; i <= COARSE; i++) {
      const t = (maxT * i) / COARSE;
      const ft = f(t);
      if (ft <= 0) {
        let lo = prevT, hi = t, flo = prevF;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          const fm = f(mid);
          if (fm > 0) {
            lo = mid;
            flo = fm;
          } else hi = mid;
        }
        return hi;
      }
      prevT = t;
      prevF = ft;
    }
    return -1;
  }
}

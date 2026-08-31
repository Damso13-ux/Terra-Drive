// Physique de vehicule : corps rigide + 4 roues sur ressorts (modele "raycast vehicle"),
// pneus a formule magique simplifiee avec cercle de friction.
//
// Repere local : +X droite, +Y haut, -Z avant (convention three.js).
// Tout est en SI : metres, kilos, newtons, secondes, radians.

import * as THREE from 'three';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;

export const DEFAULT_CONFIG = {
  mass: 1380,
  wheelBase: 2.68,
  track: 1.58,
  cgHeight: 0.52,
  bodyLength: 4.35,
  bodyWidth: 1.88,
  bodyHeight: 1.36,

  wheelRadius: 0.34,
  wheelAttachY: 0.10, // hauteur de l'ancrage de suspension : fixe la hauteur du centre de gravite
  wheelWidth: 0.24,
  wheelInertia: 1.15,

  // suspension : ~1.55 Hz a l'avant, legerement plus raide a l'arriere
  suspensionRest: 0.40,
  suspensionTravel: 0.22,
  stiffnessFront: 33000,
  stiffnessRear: 36000,
  dampCompression: 2600,
  dampRebound: 3600,
  antiRollFront: 12000,
  antiRollRear: 9000,

  // moteur
  idleRpm: 850,
  redlineRpm: 6900,
  peakTorque: 420, // N.m
  peakTorqueRpm: 3800,
  gears: [-3.30, 0, 3.42, 2.10, 1.46, 1.11, 0.89, 0.74],
  finalDrive: 3.70,
  driveline: 0.88,
  drive: 'rwd', // 'rwd' | 'fwd' | 'awd'

  brakeTorqueFront: 4600,
  brakeTorqueRear: 2900,
  handbrakeTorque: 4200,

  maxSteer: 0.60, // rad a l'arret
  minSteer: 0.115, // rad a grande vitesse
  steerSpeed: 3.4, // rad/s de mouvement du volant

  substep: 1 / 240, // pas d'integration fixe ; 1/180 suffit sur mobile
  tyreGrip: 1.55, // coefficient de base, module par la surface
  // Ce que valent les pneus hors bitume : positif pour des crampons, negatif
  // pour des semi-slicks. Applique proportionnellement a la sortie de chaussee.
  offroadBonus: 0,
  dragArea: 0.72, // Cd * A
  downforce: 0.32,
};

// Formule magique (Pacejka simplifiee) : F/Fz en fonction du glissement.
function magic(slip, B, C, E) {
  const Bs = B * slip;
  return Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}
const LONG = { B: 11.5, C: 1.65, E: 0.95 };
const LAT = { B: 13.5, C: 1.42, E: 0.96 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class Wheel {
  constructor(index, cfg) {
    this.index = index;
    this.front = index < 2;
    this.left = index % 2 === 0;
    const halfBase = cfg.wheelBase / 2;
    const halfTrack = cfg.track / 2;
    this.local = new THREE.Vector3(
      this.left ? -halfTrack : halfTrack,
      cfg.wheelAttachY,
      this.front ? -halfBase : halfBase
    );
    this.radius = cfg.wheelRadius;
    this.stiffness = this.front ? cfg.stiffnessFront : cfg.stiffnessRear;
    this.brakeTorque = this.front ? cfg.brakeTorqueFront : cfg.brakeTorqueRear;

    this.spin = 0; // rad/s
    this.angle = 0; // angle de rotation cumule, pour l'affichage
    this.steer = 0;
    this.compression = 0;
    this.suspensionLength = cfg.suspensionRest;
    this.load = 0;
    this.grounded = false;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.skid = 0; // 0..1, pour les traces et le son
    this.surfaceGrip = 1;
    this.onRoad = 0;
    this.contact = new THREE.Vector3();
    this.worldPos = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
  }
}

export class Vehicle {
  constructor(ground, config = {}) {
    this.ground = ground;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    const c = this.cfg;

    this.mass = c.mass;
    this.invMass = 1 / c.mass;
    // tenseur d'inertie diagonal approxime par un pave homogene
    const L = c.bodyLength, W = c.bodyWidth, H = c.bodyHeight;
    this.inertia = new THREE.Vector3(
      (c.mass * (H * H + L * L)) / 12, // tangage
      (c.mass * (W * W + L * L)) / 12, // lacet
      (c.mass * (W * W + H * H)) / 12  // roulis
    );
    this.invInertia = new THREE.Vector3(
      1 / this.inertia.x,
      1 / this.inertia.y,
      1 / this.inertia.z
    );

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.angularVelocity = new THREE.Vector3(); // repere LOCAL

    this.wheels = [0, 1, 2, 3].map((i) => new Wheel(i, c));

    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.steerAngle = 0;
    this.gear = 2; // index dans cfg.gears (2 = premiere)
    this.rpm = c.idleRpm;
    this.shiftTimer = 0;
    this.automatic = true;
    this.assists = { abs: true, tcs: true };
    this.substep = c.substep;
    this.airborneTime = 0;
    this.odometer = 0;

    // roues motrices, figees une fois pour toutes (pas d'allocation par pas de temps)
    this.drivenWheels = this.wheels.filter((w) =>
      c.drive === 'awd' ? true : c.drive === 'fwd' ? w.front : !w.front
    );

    // vecteurs de travail : la boucle tourne a 240 Hz, aucune allocation autorisee
    this._f = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wf = new THREE.Vector3();
    this._wr = new THREE.Vector3();
    this._vc = new THREE.Vector3();
    this._down = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._r2 = new THREE.Vector3();
  }

  get speed() {
    return this.velocity.length();
  }
  get speedKmh() {
    return this.velocity.length() * 3.6;
  }
  get forwardSpeed() {
    return this.velocity.dot(this._fwd);
  }
  get gearLabel() {
    if (this.gear === 0) return 'R';
    if (this.gear === 1) return 'N';
    return String(this.gear - 1);
  }

  get rideHeight() {
    // hauteur du centre de gravite au-dessus du sol, suspension detendue
    return this.cfg.suspensionRest + this.cfg.wheelRadius - this.cfg.wheelAttachY;
  }

  placeAt(x, y, z, heading = 0) {
    this.position.set(x, y + this.rideHeight + 0.05, z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.gear = 2;
    this.rpm = this.cfg.idleRpm;
    for (const w of this.wheels) {
      w.spin = 0;
      w.compression = 0;
      w.skid = 0;
    }
    this._updateBasis();
  }

  setInput(input) {
    Object.assign(this.input, input);
  }

  _updateBasis() {
    this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(this.quaternion);
  }

  /** Couple moteur disponible a un regime donne (courbe en cloche + coupure). */
  engineTorque(rpm) {
    const c = this.cfg;
    if (rpm > c.redlineRpm) return 0;
    const x = rpm / c.peakTorqueRpm;
    // plateau large : 0.55 a bas regime, 1.0 au pic, decroissance douce ensuite
    // Plateau tres large : une voiture qui n'a de couple qu'a mi-regime donne
    // exactement la sensation de mollesse qu'on cherche a eviter.
    let t;
    if (x < 1) t = 0.78 + 0.22 * Math.sin((Math.PI / 2) * clamp(x, 0, 1));
    else t = 1 - 0.22 * clamp((x - 1) / (c.redlineRpm / c.peakTorqueRpm - 1), 0, 1);
    return c.peakTorque * t;
  }

  update(dt) {
    // pas fixe : la stabilite d'un modele de pneu depend fortement du pas de temps
    const step = this.substep;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const h = Math.min(step, remaining);
      this._substep(h);
      remaining -= h;
    }
    this._updateBasis();
  }

  _substep(dt) {
    const c = this.cfg;
    this._updateBasis();

    // ---- direction ------------------------------------------------------
    const speed = this.velocity.length();
    const limit = c.minSteer + (c.maxSteer - c.minSteer) / (1 + speed * speed * 0.0035);
    const target = clamp(this.input.steer, -1, 1) * limit;
    const maxDelta = c.steerSpeed * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxDelta, maxDelta);

    // Ackermann approche : la roue interieure braque davantage
    for (const w of this.wheels) {
      if (!w.front) {
        w.steer = 0;
        continue;
      }
      const inner = (this.steerAngle > 0) === !w.left;
      w.steer = this.steerAngle * (inner ? 1.14 : 0.88);
    }

    // ---- accumulateurs --------------------------------------------------
    const force = this._f.set(0, -GRAVITY * this.mass, 0);
    const torque = this._t.set(0, 0, 0);

    // ---- suspension + pneus ---------------------------------------------
    let groundedCount = 0;
    for (const w of this.wheels) {
      this._wheelForces(w, dt, force, torque);
      if (w.grounded) groundedCount++;
    }
    this._antiRoll(force, torque);

    if (groundedCount === 0) this.airborneTime += dt;
    else this.airborneTime = 0;

    // ---- aerodynamique ---------------------------------------------------
    if (speed > 0.5) {
      const q = 0.5 * AIR_DENSITY * speed;
      this._v.copy(this.velocity).multiplyScalar(-q * c.dragArea);
      force.add(this._v);
      force.y -= q * speed * c.downforce; // appui
    }

    // ---- transmission ----------------------------------------------------
    this._drivetrain(dt);

    // ---- integration -----------------------------------------------------
    this._v.copy(force).multiplyScalar(this.invMass * dt);
    this.velocity.add(this._v);

    // couple monde -> local, puis acceleration angulaire
    this._q.copy(this.quaternion).invert();
    this._v.copy(torque).applyQuaternion(this._q);
    this.angularVelocity.x += this._v.x * this.invInertia.x * dt;
    this.angularVelocity.y += this._v.y * this.invInertia.y * dt;
    this.angularVelocity.z += this._v.z * this.invInertia.z * dt;

    // amortissement : en l'air on laisse tourner, au sol on calme le lacet parasite
    const damp = groundedCount > 0 ? 0.995 : 0.999;
    this.angularVelocity.multiplyScalar(damp);

    this.position.addScaledVector(this.velocity, dt);
    this.odometer += this.velocity.length() * dt;

    // q += 0.5 * w * q * dt
    this._v.copy(this.angularVelocity).applyQuaternion(this.quaternion);
    this._q.set(this._v.x, this._v.y, this._v.z, 0).multiply(this.quaternion);
    this.quaternion.x += this._q.x * 0.5 * dt;
    this.quaternion.y += this._q.y * 0.5 * dt;
    this.quaternion.z += this._q.z * 0.5 * dt;
    this.quaternion.w += this._q.w * 0.5 * dt;
    this.quaternion.normalize();

    this._safety();
  }

  _wheelForces(wheel, dt, force, torque) {
    const c = this.cfg;
    const maxLen = c.suspensionRest + wheel.radius;

    // point d'ancrage en coordonnees monde
    this._r.copy(wheel.local).applyQuaternion(this.quaternion);
    wheel.worldPos.copy(this.position).add(this._r);

    const down = this._down.copy(this._up).multiplyScalar(-1);
    const t = this.ground.raycast(
      wheel.worldPos.x, wheel.worldPos.y, wheel.worldPos.z,
      down.x, down.y, down.z,
      maxLen
    );

    if (t < 0) {
      wheel.grounded = false;
      wheel.load = 0;
      wheel.skid *= 0.9;
      wheel.suspensionLength = c.suspensionRest;
      wheel.compression = 0;
      // la roue libre ralentit doucement
      // roue en l'air : le frein moteur et les freins agissent encore, rien ne s'emballe
      const freeBrake = (wheel.engineBrake || 0) + this.input.brake * wheel.brakeTorque;
      const dOmega = (freeBrake / c.wheelInertia) * dt;
      if (Math.abs(wheel.spin) <= dOmega) wheel.spin = 0;
      else wheel.spin -= Math.sign(wheel.spin) * dOmega;
      wheel.spin *= 1 - 0.4 * dt;
      wheel.spin = clamp(wheel.spin, -310, 310);
      wheel.angle += wheel.spin * dt;
      wheel.contact.copy(wheel.worldPos).addScaledVector(down, maxLen);
      return;
    }

    wheel.grounded = true;
    wheel.contact.copy(wheel.worldPos).addScaledVector(down, t);
    const probe = this.ground.probe(wheel.contact.x, wheel.contact.z);
    const n = this.ground.normal(wheel.contact.x, wheel.contact.z);
    wheel.normal.set(n.x, n.y, n.z);
    wheel.onRoad = probe.onRoad;
    wheel.surfaceGrip = probe.grip * (1 + (1 - probe.onRoad) * c.offroadBonus);

    const susLen = clamp(t - wheel.radius, c.suspensionRest - c.suspensionTravel, c.suspensionRest);
    wheel.suspensionLength = susLen;
    const compression = c.suspensionRest - susLen;
    wheel.compression = compression;

    // vitesse du point de contact
    const vc = this._contactVelocity(wheel.contact, this._vc);
    const susVel = vc.dot(this._up);
    const damping = susVel > 0 ? c.dampRebound : c.dampCompression;
    let fSus = wheel.stiffness * compression - damping * susVel;
    // butee de compression : evite de traverser le sol sur les gros chocs
    if (compression >= c.suspensionTravel * 0.98) {
      fSus += 90000 * (compression - c.suspensionTravel * 0.98);
    }
    fSus = Math.max(0, fSus);
    wheel.load = fSus;

    force.addScaledVector(this._up, fSus);
    this._r.copy(wheel.contact).sub(this.position);
    this._v.copy(this._up).multiplyScalar(fSus);
    this._addTorque(torque, this._r, this._v);

    // ---- reperes du pneu, projetes sur le plan de contact ----------------
    const wf = this._wf;
    wf.copy(this._fwd).applyAxisAngle(this._up, -wheel.steer);
    wf.addScaledVector(wheel.normal, -wf.dot(wheel.normal)).normalize();
    const wr = this._wr.crossVectors(wf, wheel.normal).normalize();

    const vLong = vc.dot(wf);
    const vLat = vc.dot(wr);

    // ---- glissements ------------------------------------------------------
    const ref = Math.max(Math.abs(vLong), 2.5);
    let slipRatio = (wheel.spin * wheel.radius - vLong) / ref;
    slipRatio = clamp(slipRatio, -6, 6);
    const slipAngle = Math.atan2(vLat, Math.abs(vLong) + 1.2);
    wheel.slipRatio = slipRatio;
    wheel.slipAngle = slipAngle;

    // sensibilite a la charge : le mu chute quand la roue est tres chargee
    const nominal = (this.mass * GRAVITY) / 4;
    const loadFactor = clamp(1.12 - 0.12 * (fSus / nominal), 0.72, 1.14);
    const mu = c.tyreGrip * wheel.surfaceGrip * loadFactor;
    const D = mu * fSus;

    let fx = D * magic(slipRatio, LONG.B, LONG.C, LONG.E);
    let fy = -D * magic(slipAngle, LAT.B, LAT.C, LAT.E);

    // cercle de friction
    const total = Math.hypot(fx, fy);
    if (total > D && total > 1e-3) {
      const k = D / total;
      fx *= k;
      fy *= k;
    }
    wheel.skid = clamp(total / Math.max(D, 1) - 0.82, 0, 0.18) / 0.18;

    // ---- dynamique de rotation de la roue --------------------------------
    let wheelTorque = wheel.driveTorque || 0;
    let brake = this.input.brake * wheel.brakeTorque + (wheel.engineBrake || 0);
    if (!wheel.front) brake += this.input.handbrake * c.handbrakeTorque;

    if (this.assists.abs && brake > 0 && Math.abs(vLong) > 3) {
      // on relache la pression si la roue part au blocage
      const lock = clamp(-slipRatio - 0.22, 0, 0.5) / 0.5;
      brake *= 1 - 0.45 * lock;
    }

    wheelTorque -= fx * wheel.radius;
    const spinBefore = wheel.spin;
    wheel.spin += (wheelTorque / c.wheelInertia) * dt;

    if (brake > 0) {
      const dOmega = (brake / c.wheelInertia) * dt;
      if (Math.abs(wheel.spin) <= dOmega) wheel.spin = 0;
      else wheel.spin -= Math.sign(wheel.spin) * dOmega;
    }
    if (Math.abs(wheel.spin) < 0.05 && Math.abs(vLong) < 0.2) wheel.spin = 0;
    // garde-fou : une roue ne peut pas depasser ~380 km/h de vitesse peripherique
    wheel.spin = clamp(wheel.spin, -310, 310);
    wheel.angle += ((wheel.spin + spinBefore) * 0.5) * dt;

    // ---- resistance au roulement ------------------------------------------
    const crr = 0.013 + (1 - wheel.onRoad) * 0.028;
    const roll = -Math.sign(vLong) * crr * fSus * Math.min(1, Math.abs(vLong) / 0.5);

    // ---- application ------------------------------------------------------
    this._v.copy(wf).multiplyScalar(fx + roll).addScaledVector(wr, fy);
    force.add(this._v);
    this._addTorque(torque, this._r, this._v);
  }

  _antiRoll(force, torque) {
    const c = this.cfg;
    for (let axle = 0; axle < 2; axle++) {
      const left = this.wheels[axle * 2];
      const right = this.wheels[axle * 2 + 1];
      if (!left.grounded && !right.grounded) continue;
      const k = axle === 0 ? c.antiRollFront : c.antiRollRear;
      const diff = left.compression - right.compression;
      const f = k * diff;
      for (const [w, sign] of [[left, -1], [right, 1]]) {
        if (!w.grounded) continue;
        this._v.copy(this._up).multiplyScalar(f * sign);
        force.add(this._v);
        this._r.copy(w.contact).sub(this.position);
        this._addTorque(torque, this._r, this._v);
      }
    }
  }

  _drivetrain(dt) {
    const c = this.cfg;
    const driven = this.drivenWheels;

    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    const ratio = c.gears[this.gear] * c.finalDrive;
    let avgSpin = 0;
    for (const w of driven) avgSpin += w.spin;
    avgSpin /= driven.length;

    if (ratio !== 0) {
      const target = Math.abs(avgSpin * ratio) * (60 / (2 * Math.PI));
      this.rpm += (clamp(target, c.idleRpm, c.redlineRpm + 200) - this.rpm) * Math.min(1, dt * 18);
    } else {
      const target = c.idleRpm + this.input.throttle * 4200;
      this.rpm += (target - this.rpm) * Math.min(1, dt * 4);
    }

    let throttle = clamp(this.input.throttle, 0, 1);
    if (this.shiftTimer > 0) throttle = 0;

    // antipatinage : coupe le couple si les roues motrices s'emballent
    if (this.assists.tcs && throttle > 0) {
      let worst = 0;
      for (const w of driven) if (w.grounded) worst = Math.max(worst, Math.abs(w.slipRatio));
      // Couper des 0.28 de glissement bridait l'acceleration en permanence.
      if (worst > 0.65) throttle *= clamp(1 - (worst - 0.65) * 0.9, 0.55, 1);
    }

    let engine = throttle < 0.03 ? 0 : this.engineTorque(this.rpm) * throttle;
    if (this.rpm >= c.redlineRpm) engine = 0;

    // Frein moteur : couple resistant, applique via le circuit de freinage. Le passer
    // en couple moteur negatif ferait tourner les roues a l'envers quand elles decollent.
    const engineBrake =
      throttle < 0.03 && ratio !== 0
        ? 0.13 * c.peakTorque * (0.35 + 0.65 * (this.rpm / c.redlineRpm)) * Math.abs(ratio) * c.driveline
        : 0;

    const axleTorque = ratio === 0 ? 0 : engine * ratio * c.driveline;
    for (const w of this.wheels) {
      w.driveTorque = 0;
      w.engineBrake = 0;
    }
    for (const w of driven) {
      w.driveTorque = axleTorque / driven.length;
      w.engineBrake = engineBrake / driven.length;
    }

    if (this.automatic) this._autoShift();
  }

  _autoShift() {
    const c = this.cfg;
    if (this.shiftTimer > 0) return;
    const fwd = this.forwardSpeed;

    // marche arriere / avant selon l'intention du joueur
    if (this.gear >= 2 && this.input.brake > 0.6 && fwd < 0.6 && this.input.throttle < 0.05) {
      this.gear = 0;
      this.shiftTimer = 0.25;
      return;
    }
    if (this.gear === 0 && this.input.throttle > 0.3 && fwd > -0.6) {
      this.gear = 2;
      this.shiftTimer = 0.25;
      return;
    }
    if (this.gear < 2) return;

    if (this.rpm > c.redlineRpm - 500 && this.gear < c.gears.length - 1 && this.input.throttle > 0.1) {
      this.gear++;
      this.shiftTimer = 0.16;
    } else if (this.rpm < 2300 && this.gear > 2) {
      this.gear--;
      this.shiftTimer = 0.12;
    }
  }

  _contactVelocity(point, out) {
    // v + (omega_monde x r)
    const r = this._r2.copy(point).sub(this.position);
    const w = out.copy(this.angularVelocity).applyQuaternion(this.quaternion);
    const cx = w.y * r.z - w.z * r.y;
    const cy = w.z * r.x - w.x * r.z;
    const cz = w.x * r.y - w.y * r.x;
    return out.set(this.velocity.x + cx, this.velocity.y + cy, this.velocity.z + cz);
  }

  /** torque += r x f, sans allocation. */
  _addTorque(torque, r, f) {
    torque.x += r.y * f.z - r.z * f.y;
    torque.y += r.z * f.x - r.x * f.z;
    torque.z += r.x * f.y - r.y * f.x;
  }

  /** Garde-fous : rien ne doit pouvoir envoyer la voiture a l'infini. */
  _safety() {
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      this.position.set(0, 200, 0);
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.quaternion.identity();
      return;
    }
    const vmax = 130; // ~470 km/h
    if (this.velocity.lengthSq() > vmax * vmax) this.velocity.setLength(vmax);
    if (this.angularVelocity.lengthSq() > 400) this.angularVelocity.setLength(20);

    // remontee d'urgence si le corps passe sous la surface
    const h = this.ground.height(this.position.x, this.position.z);
    const minY = h + 0.25;
    if (this.position.y < minY) {
      this.position.y = minY;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  /** Remet la voiture a l'endroit, sur place. */
  rightUp() {
    const h = this.ground.height(this.position.x, this.position.z);
    const yaw = Math.atan2(-this._fwd.x, -this._fwd.z);
    this.placeAt(this.position.x, h, this.position.z, yaw);
  }
}

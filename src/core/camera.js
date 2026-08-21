// Camera de poursuite. Ressort critique amorti, cadrage oriente par la trajectoire
// (et non par le nez de la voiture), champ de vision qui s'ouvre avec la vitesse.

import * as THREE from 'three';

const MODES = ['chase', 'hood', 'orbit'];

export class ChaseCamera {
  constructor(camera, ground) {
    this.camera = camera;
    this.ground = ground;
    this.mode = 'chase';
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.lookVel = new THREE.Vector3();
    this.yaw = 0;
    this.orbitYaw = 0;
    this.orbitPitch = 0.35;
    this.orbitDist = 12;
    this.baseFov = 62;

    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._initialised = false;
  }

  cycleMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this._initialised = false;
    return this.mode;
  }

  update(vehicle, dt) {
    const cam = this.camera;
    const speed = vehicle.speed;

    if (this.mode === 'hood') {
      this._target.set(0, 0.62, -0.35).applyQuaternion(vehicle.quaternion).add(vehicle.position);
      cam.position.copy(this._target);
      cam.quaternion.copy(vehicle.quaternion);
      cam.rotateX(-0.02);
      cam.fov = this.baseFov + Math.min(18, speed * 0.42);
      cam.updateProjectionMatrix();
      return;
    }

    // cap suivi : le nez de la voiture a basse vitesse, la trajectoire au-dela
    this._fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
    let heading = Math.atan2(this._fwd.x, -this._fwd.z);
    if (speed > 3) {
      const vHeading = Math.atan2(vehicle.velocity.x, -vehicle.velocity.z);
      const reversing = vehicle.forwardSpeed < -0.5;
      if (!reversing) {
        const blend = Math.min(0.65, (speed - 3) / 22);
        heading += shortestAngle(heading, vHeading) * blend;
      }
    }

    if (this.mode === 'orbit') {
      heading = this.orbitYaw;
    }
    this.yaw += shortestAngle(this.yaw, heading) * Math.min(1, dt * 6);

    const dist = this.mode === 'orbit' ? this.orbitDist : 6.0 + Math.min(3.4, speed * 0.075);
    const height = this.mode === 'orbit' ? this.orbitDist * Math.sin(this.orbitPitch) : 2.25;

    this._desired.set(
      vehicle.position.x + Math.sin(this.yaw) * -dist,
      vehicle.position.y + height,
      vehicle.position.z + Math.cos(this.yaw) * dist
    );

    if (!this._initialised) {
      this.pos.copy(this._desired);
      this.look.copy(vehicle.position);
      this._initialised = true;
    }

    spring(this.pos, this._desired, this.vel, this.mode === 'orbit' ? 9 : 6.5, dt);

    // ne jamais passer sous le decor
    const floor = this.ground.height(this.pos.x, this.pos.z) + 0.9;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // point vise : legerement devant la voiture
    this._target.copy(vehicle.position).addScaledVector(this._fwd, Math.min(9, speed * 0.28));
    this._target.y += 0.9;
    spring(this.look, this._target, this.lookVel, 10, dt);

    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    cam.fov = this.baseFov + Math.min(16, Math.max(0, speed - 6) * 0.34);
    cam.updateProjectionMatrix();
  }

  orbitDrag(dx, dy) {
    this.orbitYaw -= dx * 0.006;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.004, 0.05, 1.3);
  }
  orbitZoom(delta) {
    this.orbitDist = THREE.MathUtils.clamp(this.orbitDist * (1 + delta * 0.001), 4, 120);
  }
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function spring(current, target, velocity, omega, dt) {
  // ressort critique amorti, integration semi-implicite
  const k = omega * omega;
  const c = 2 * omega;
  velocity.x += ((target.x - current.x) * k - velocity.x * c) * dt;
  velocity.y += ((target.y - current.y) * k - velocity.y * c) * dt;
  velocity.z += ((target.z - current.z) * k - velocity.z * c) * dt;
  current.addScaledVector(velocity, dt);
}

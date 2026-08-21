// Representation visuelle du vehicule : carrosserie procedurale, roues suspendues,
// feux, poussiere et traces de derapage.

import * as THREE from 'three';

export class CarView {
  constructor(scene, vehicle, { color = 0xd23c2e, skidPoints = 2400 } = {}) {
    this.vehicle = vehicle;
    const c = vehicle.cfg;

    this.group = new THREE.Group();
    this.group.name = 'car';
    scene.add(this.group);

    const paint = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.55,
      roughness: 0.32,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.3, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x1d2833,
      metalness: 0.1,
      roughness: 0.06,
      transparent: true,
      opacity: 0.55,
    });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.25 });
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0xfff2d0,
      emissive: 0xfff0c8,
      emissiveIntensity: 0.15,
      roughness: 0.2,
    });
    this.brakeMat = new THREE.MeshStandardMaterial({
      color: 0x6a0d0d,
      emissive: 0xff1a1a,
      emissiveIntensity: 0.12,
      roughness: 0.4,
    });

    const L = c.bodyLength, W = c.bodyWidth;
    const body = new THREE.Group();

    const lower = mesh(new THREE.BoxGeometry(W, 0.60, L * 0.92), paint, 0, 0.14, 0);
    body.add(lower);

    // capot / coffre legerement plus bas que l'habitacle
    body.add(mesh(new THREE.BoxGeometry(W * 0.96, 0.22, L * 0.30), paint, 0, 0.47, -L * 0.29));
    body.add(mesh(new THREE.BoxGeometry(W * 0.96, 0.20, L * 0.22), paint, 0, 0.46, L * 0.33));

    // habitacle
    const cabin = mesh(new THREE.BoxGeometry(W * 0.88, 0.50, L * 0.44), paint, 0, 0.68, L * 0.03);
    body.add(cabin);
    // vitrages
    body.add(mesh(new THREE.BoxGeometry(W * 0.80, 0.34, L * 0.42), glass, 0, 0.70, L * 0.03));
    body.add(mesh(new THREE.BoxGeometry(W * 0.89, 0.30, L * 0.02), glass, 0, 0.66, -L * 0.19));

    // bas de caisse et boucliers
    body.add(mesh(new THREE.BoxGeometry(W * 1.01, 0.18, L * 0.62), dark, 0, -0.14, 0));
    body.add(mesh(new THREE.BoxGeometry(W * 0.99, 0.26, 0.20), dark, 0, 0.02, -L * 0.475));
    body.add(mesh(new THREE.BoxGeometry(W * 0.99, 0.26, 0.20), dark, 0, 0.02, L * 0.475));
    body.add(mesh(new THREE.BoxGeometry(W * 0.30, 0.10, 0.06), chrome, 0, 0.20, -L * 0.49));

    // feux
    for (const s of [-1, 1]) {
      body.add(mesh(new THREE.BoxGeometry(0.34, 0.14, 0.08), this.headMat, s * W * 0.33, 0.34, -L * 0.47));
      body.add(mesh(new THREE.BoxGeometry(0.36, 0.13, 0.07), this.brakeMat, s * W * 0.33, 0.38, L * 0.47));
    }

    body.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(body);
    this.body = body;

    // ---- roues -----------------------------------------------------------
    const tyreGeo = new THREE.CylinderGeometry(c.wheelRadius, c.wheelRadius, c.wheelWidth, 22);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(c.wheelRadius * 0.62, c.wheelRadius * 0.62, c.wheelWidth * 1.02, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.85, roughness: 0.3 });

    this.wheelPivots = [];
    this.wheelSpins = [];
    for (const w of vehicle.wheels) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(w.local);
      const spin = new THREE.Object3D();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      tyre.castShadow = true;
      rim.castShadow = true;
      spin.add(tyre, rim);
      pivot.add(spin);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpins.push(spin);
    }

    // ---- phares ----------------------------------------------------------
    this.headlights = new THREE.Group();
    for (const s of [-1, 1]) {
      const light = new THREE.SpotLight(0xfff0d0, 0, 90, 0.42, 0.55, 1.2);
      light.position.set(s * W * 0.33, 0.34, -L * 0.47);
      light.target.position.set(s * W * 0.5, -0.6, -30);
      this.headlights.add(light, light.target);
    }
    this.group.add(this.headlights);
    this.lightsOn = false;

    this.skid = new SkidMarks(scene, vehicle, skidPoints);
  }

  setLights(on) {
    this.lightsOn = on;
    for (const o of this.headlights.children) {
      if (o.isSpotLight) o.intensity = on ? 120 : 0;
    }
    this.headMat.emissiveIntensity = on ? 1.6 : 0.15;
  }

  update(dt) {
    const v = this.vehicle;
    this.group.position.copy(v.position);
    this.group.quaternion.copy(v.quaternion);

    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      const pivot = this.wheelPivots[i];
      pivot.position.y = w.local.y - w.suspensionLength;
      pivot.rotation.y = -w.steer;
      this.wheelSpins[i].rotation.x = -w.angle;
    }

    this.brakeMat.emissiveIntensity = 0.12 + v.input.brake * 2.2;
    this.skid.update(dt);
  }
}

/** Traces de gomme : un ruban par roue, recycle en anneau. */
class SkidMarks {
  constructor(scene, vehicle, max = 2400) {
    this.vehicle = vehicle;
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.max * 3);
    this.opacities = new Float32Array(this.max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.opacities, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    const mat = new THREE.PointsMaterial({
      color: 0x1a1614,
      size: 0.34,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.head = 0;
    this.count = 0;
    this.timer = 0;
  }

  update(dt) {
    this.timer += dt;
    if (this.timer < 0.02) return;
    this.timer = 0;
    for (const w of this.vehicle.wheels) {
      if (!w.grounded || w.skid < 0.35 || w.onRoad < 0.4) continue;
      const i = this.head;
      this.positions[i * 3] = w.contact.x;
      this.positions[i * 3 + 1] = w.contact.y + 0.04;
      this.positions[i * 3 + 2] = w.contact.z;
      this.head = (this.head + 1) % this.max;
      this.count = Math.min(this.count + 1, this.max);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, this.count);
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.geo.setDrawRange(0, 0);
  }
}

function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// Representation visuelle du vehicule.
//
// La carrosserie est une surface lissee entre sections (voir bodywork.js), pas
// un empilement de boites. Les matieres comptent autant que la forme : une
// peinture a vernis, du chrome, du caoutchouc mat et un vitrage teinte se lisent
// immediatement comme une voiture, la ou un materiau unique donne un jouet.

import * as THREE from 'three';
import { loft, scaleStations, buildWheel, SHAPES } from './bodywork.js';

export class CarView {
  constructor(scene, vehicle, { color = 0xd23c2e, shape = 'berline', skidPoints = 2400 } = {}) {
    this.vehicle = vehicle;
    this.scene = scene;
    const c = vehicle.cfg;

    this.group = new THREE.Group();
    this.group.name = 'car';
    scene.add(this.group);

    this.materials = makeMaterials(color);
    const silhouette = SHAPES[shape] || SHAPES.berline;
    // Les silhouettes sont cotees depuis le sol ; le repere du vehicule part du
    // centre de gravite. C'est ce decalage qui pose la caisse sur ses roues.
    const drop = vehicle.rideHeight;

    // ---- caisse ------------------------------------------------------------
    const body = new THREE.Mesh(
      loft(scaleStations(silhouette.body, c.bodyLength, c.bodyWidth, c.bodyHeight, drop)),
      this.materials.paint
    );
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    // ---- habitacle vitre ---------------------------------------------------
    const cabin = new THREE.Mesh(
      loft(scaleStations(silhouette.cabin, c.bodyLength, c.bodyWidth, c.bodyHeight, drop)),
      this.materials.glass
    );
    cabin.castShadow = true;
    this.group.add(cabin);
    this.cabin = cabin;

    for (const piece of this._trim(c)) this.group.add(piece);

    // ---- roues -------------------------------------------------------------
    const wheel = buildWheel(c.wheelRadius, c.wheelWidth);
    this.wheelGeo = wheel;
    this.wheelPivots = [];
    this.wheelSpins = [];

    for (const w of vehicle.wheels) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(w.local);

      const spin = new THREE.Object3D();
      const tyre = new THREE.Mesh(wheel.tyre, this.materials.rubber);
      const rim = new THREE.Mesh(wheel.rim, this.materials.alloy);
      const disc = new THREE.Mesh(wheel.disc, this.materials.steel);
      tyre.castShadow = true;
      rim.castShadow = true;
      // La roue droite est le miroir de la gauche : sans cela la jante est
      // tournee vers l'interieur d'un cote de la voiture.
      spin.scale.x = w.left ? -1 : 1;
      spin.add(tyre, rim, disc);

      pivot.add(spin);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpins.push(spin);
    }

    // ---- phares ------------------------------------------------------------
    this.headlights = new THREE.Group();
    for (const s of [-1, 1]) {
      const light = new THREE.SpotLight(0xfff0d0, 0, 95, 0.45, 0.55, 1.2);
      light.position.set(s * c.bodyWidth * 0.32, c.bodyHeight * 0.3, -c.bodyLength * 0.47);
      light.target.position.set(s * c.bodyWidth * 0.6, -0.7, -32);
      this.headlights.add(light, light.target);
    }
    this.group.add(this.headlights);
    this.lightsOn = false;

    this.skid = new SkidMarks(scene, vehicle, skidPoints);
  }

  /** Boucliers, feux, calandre, retroviseurs, echappement, plaque. */
  _trim(c) {
    const L = c.bodyLength;
    const W = c.bodyWidth;
    const H = c.bodyHeight;
    const drop = this.vehicle.rideHeight;
    const out = [];

    const add = (geo, mat, x, y, z, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y - drop, z);
      m.castShadow = cast;
      out.push(m);
    };

    // Bas de caisse sombre : casse la masse coloree et pose la voiture au sol.
    add(new THREE.BoxGeometry(W * 0.99, H * 0.075, L * 0.5), this.materials.plastic, 0, H * 0.225, 0, false);

    // boucliers
    add(new THREE.BoxGeometry(W * 0.86, H * 0.11, L * 0.035), this.materials.plastic, 0, H * 0.30, -L * 0.462);
    add(new THREE.BoxGeometry(W * 0.86, H * 0.11, L * 0.035), this.materials.plastic, 0, H * 0.32, L * 0.462);

    // calandre et jonc chrome
    add(new THREE.BoxGeometry(W * 0.40, H * 0.075, L * 0.012), this.materials.grille, 0, H * 0.38, -L * 0.474);
    add(new THREE.BoxGeometry(W * 0.42, H * 0.012, L * 0.008), this.materials.chrome, 0, H * 0.425, -L * 0.476);

    for (const s of [-1, 1]) {
      // affleurants : un bloc qui depasse se lit comme une piece rapportee
      add(new THREE.BoxGeometry(W * 0.17, H * 0.05, L * 0.014), this.materials.head, s * W * 0.31, H * 0.455, -L * 0.472);
      add(new THREE.BoxGeometry(W * 0.18, H * 0.045, L * 0.012), this.materials.brake, s * W * 0.31, H * 0.465, L * 0.472);
      // retroviseur : bras puis coque
      add(new THREE.BoxGeometry(W * 0.055, H * 0.015, L * 0.01), this.materials.plastic, s * W * 0.48, H * 0.615, -L * 0.14);
      add(new THREE.BoxGeometry(W * 0.04, H * 0.042, L * 0.018), this.materials.paint, s * W * 0.52, H * 0.625, -L * 0.14);
    }

    // troisieme feu stop, en haut de la lunette
    add(new THREE.BoxGeometry(W * 0.3, H * 0.014, L * 0.012), this.materials.brake, 0, H * 0.86, L * 0.4);

    const pipe = new THREE.CylinderGeometry(H * 0.032, H * 0.032, L * 0.05, 10);
    pipe.rotateX(Math.PI / 2);
    add(pipe, this.materials.chrome, W * 0.3, H * 0.26, L * 0.49);

    add(new THREE.BoxGeometry(W * 0.24, H * 0.045, L * 0.006), this.materials.plate, 0, H * 0.34, L * 0.474);

    return out;
  }

  setLights(on) {
    this.lightsOn = on;
    for (const o of this.headlights.children) {
      if (o.isSpotLight) o.intensity = on ? 130 : 0;
    }
    this.materials.head.emissiveIntensity = on ? 2.2 : 0.12;
  }

  update(dt) {
    const v = this.vehicle;
    this.group.position.copy(v.position);
    this.group.quaternion.copy(v.quaternion);

    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      this.wheelPivots[i].position.y = w.local.y - w.suspensionLength;
      this.wheelPivots[i].rotation.y = -w.steer;
      // le miroir applique a la roue droite inverse aussi son sens de rotation
      this.wheelSpins[i].rotation.x = -w.angle * (w.left ? 1 : -1);
    }

    this.materials.brake.emissiveIntensity = 0.1 + v.input.brake * 2.4;
    this.skid.update(dt);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of Object.values(this.materials)) m.dispose();
    this.scene.remove(this.skid.points);
    this.skid.points.geometry.dispose();
    this.skid.points.material.dispose();
  }
}

/**
 * Matieres.
 *
 * Le vernis (`clearcoat`) est ce qui distingue une peinture automobile d'un
 * plastique colore : une seconde couche speculaire par-dessus la teinte. Sans
 * lui, aucune carrosserie ne semble peinte.
 */
function makeMaterials(colour) {
  return {
    paint: new THREE.MeshPhysicalMaterial({
      color: colour,
      metalness: 0.45,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.07,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x0d151d,
      metalness: 0.35,
      roughness: 0.05,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.96, metalness: 0 }),
    alloy: new THREE.MeshStandardMaterial({ color: 0x8b9199, roughness: 0.34, metalness: 0.88 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.62, metalness: 0.55 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.14, metalness: 1 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.78, metalness: 0.05 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.62, metalness: 0.35 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xdcdcd2, roughness: 0.7, metalness: 0 }),
    head: new THREE.MeshStandardMaterial({
      color: 0xf2f4ff,
      emissive: 0xfff0c8,
      emissiveIntensity: 0.05,
      roughness: 0.12,
      metalness: 0.1,
    }),
    brake: new THREE.MeshStandardMaterial({
      color: 0x5e0c0c,
      emissive: 0xff1a1a,
      emissiveIntensity: 0.1,
      roughness: 0.35,
    }),
  };
}

/** Traces de gomme : un nuage de points recycle en anneau. */
class SkidMarks {
  constructor(scene, vehicle, max = 2400) {
    this.vehicle = vehicle;
    this.max = Math.max(1, max);
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
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

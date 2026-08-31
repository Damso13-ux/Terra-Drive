// Representation visuelle du vehicule.
//
// La carrosserie est une surface lissee entre sections (voir bodywork.js), pas
// un empilement de boites. Les matieres comptent autant que la forme : une
// peinture a vernis, du chrome, du caoutchouc mat et un vitrage teinte se lisent
// immediatement comme une voiture, la ou un materiau unique donne un jouet.

import * as THREE from 'three';
import { loft, densify, scaleStations, buildWheel, roofFromCabin, SHAPES } from './bodywork.js';

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

    // ---- caisse, passages de roue creuses -----------------------------------
    //
    // La roue est a track/2 du centre, la carrosserie va plus loin encore : sans
    // creusement elle est purement et simplement noyee dans la peinture. On
    // rentre donc le flanc sous la ligne d'arche jusqu'a la paroi du logement.
    // Centre de roue dans le repere du maillage.
    //
    // `scaleStations` mesure les hauteurs depuis le SOL puis retranche `drop` :
    // le sol est donc a -drop, et le moyeu un rayon plus haut. Repartir de
    // `wheelAttachY`, qui est deja dans le repere du centre de gravite, revient
    // a compter le decalage deux fois et envoie l'arche sous la voiture.
    const wheelY = c.wheelRadius - drop;
    const bodyStations = densify(
      scaleStations(silhouette.body, c.bodyLength, c.bodyWidth, c.bodyHeight, drop),
      84 // assez de sections pour que le bord d'aile soit net, non en marches
    );

    // Le rayon d'arche est borne par la tole reellement disponible au-dessus de
    // la roue : sur une caisse basse, un rayon fixe fait sortir l'ouverture par
    // le haut du flanc et sectionne l'aile.
    const topAt = (z) => {
      let best = bodyStations[0];
      for (const st of bodyStations) {
        if (Math.abs(st.z - z) < Math.abs(best.z - z)) best = st;
      }
      return best.yHigh;
    };
    const archRadius = (z) => {
      const room = topAt(z) - wheelY - 0.05; // tole a garder au-dessus du pneu
      if (room < c.wheelRadius + 0.02) {
        // La caisse est trop basse pour ses jantes : l'arche ne peut pas
        // degager le pneu, qui ressortira par le haut de l'aile. C'est une
        // incoherence de configuration, pas un accident de rendu.
        console.warn(
          `[carview] ${c.id ?? 'vehicule'} : aile trop basse, ` +
            `${(room * 100).toFixed(0)} cm pour un pneu de ` +
            `${(c.wheelRadius * 100).toFixed(0)} cm`
        );
      }
      return Math.min(c.wheelRadius * 1.14, room);
    };

    const wells = {
      wheels: [
        { z: -c.wheelBase / 2, y: wheelY, radius: archRadius(-c.wheelBase / 2) },
        { z: c.wheelBase / 2, y: wheelY, radius: archRadius(c.wheelBase / 2) },
      ],
      // Paroi juste EN DEDANS DE LA FACE EXTERNE du pneu, pas de sa face
      // interne : sur une voiture la roue affleure l'aile. Reculer le flanc
      // jusqu'a la face interne creuserait une caverne de 30 cm dans laquelle
      // la roue flotterait, au fond d'une ombre noire.
      houseHalfW: Math.min(
        c.track / 2 + c.wheelWidth / 2 - 0.05,
        c.bodyWidth / 2 - 0.05
      ),
    };

    const body = new THREE.Mesh(loft(bodyStations, 22, wells), this.materials.paint);
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

    // ---- pavillon ----------------------------------------------------------
    const roofStations = roofFromCabin(silhouette.cabin);
    if (roofStations) {
      const roof = new THREE.Mesh(
        loft(scaleStations(roofStations, c.bodyLength, c.bodyWidth, c.bodyHeight, drop)),
        this.materials.paint
      );
      roof.castShadow = true;
      this.group.add(roof);
    }

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
      // le bras part du flanc (a 0,51 de largeur) et porte la coque au-dela
      add(new THREE.BoxGeometry(W * 0.09, H * 0.014, L * 0.009), this.materials.plastic, s * W * 0.545, H * 0.60, -L * 0.13);
      add(new THREE.BoxGeometry(W * 0.05, H * 0.045, L * 0.02), this.materials.paint, s * W * 0.60, H * 0.615, -L * 0.13);
    }

    // Troisieme feu stop, plaque en haut de la lunette. Il flottait 39 cm
    // au-dessus du coffre, ce qui se lisait comme une antenne.
    add(new THREE.BoxGeometry(W * 0.26, H * 0.012, L * 0.01), this.materials.brake, 0, H * 0.60, L * 0.33);

    const pipe = new THREE.CylinderGeometry(H * 0.032, H * 0.032, L * 0.05, 10);
    pipe.rotateX(Math.PI / 2);
    // en acier : le chrome refletait le ciel et donnait un cylindre bleu vif
    add(pipe, this.materials.steel, W * 0.28, H * 0.255, L * 0.455);

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
      // 0.82 donnait un bloc noir pose sur la caisse : un vitrage doit laisser
      // deviner l'habitacle et refleter le ciel, pas boucher la silhouette.
      color: 0x1b2a38,
      metalness: 0.45,
      roughness: 0.04,
      transparent: true,
      opacity: 0.68,
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

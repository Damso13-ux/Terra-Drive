// Ciel, soleil, brume et carte d'environnement. L'heure du jour pilote tout d'un coup.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const SHADOW_EXTENT = 90; // demi-largeur de la zone d'ombre portee, en metres

export class Atmosphere {
  constructor(scene, renderer, { hour = 10, fogDistance = 2800 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.fogDistance = fogDistance;

    this.sky = new Sky();
    this.sky.scale.setScalar(600000);
    this.sky.material.uniforms.turbidity.value = 4.5;
    this.sky.material.uniforms.rayleigh.value = 2.2;
    this.sky.material.uniforms.mieCoefficient.value = 0.005;
    this.sky.material.uniforms.mieDirectionalG.value = 0.8;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 600;
    this.sun.shadow.camera.left = -SHADOW_EXTENT;
    this.sun.shadow.camera.right = SHADOW_EXTENT;
    this.sun.shadow.camera.top = SHADOW_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_EXTENT;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa8c4e8, 0x6b6350, 0.6);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0x9fb6cc, fogDistance * 0.28, fogDistance);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this._envScene = new THREE.Scene();
    this._sunDir = new THREE.Vector3();
    this._envDirty = true;
    this._envTimer = 0;

    this.setHour(hour);
  }

  /** @param hour 0..24 */
  setHour(hour) {
    this.hour = hour;
    // course du soleil simplifiee : culmine a midi, se leve vers 6 h, se couche vers 20 h
    const t = ((hour - 6) / 14) * Math.PI; // 0 au lever, PI au coucher
    const elevation = Math.sin(t) * 62; // degres
    const azimuth = 100 + ((hour - 6) / 14) * 160;

    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this._sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this._sunDir);

    const day = THREE.MathUtils.clamp((elevation + 4) / 20, 0, 1);
    this.sun.intensity = 0.08 + 1.95 * day;
    this.sun.color.setHSL(0.09 + 0.03 * day, 0.55 - 0.4 * day, 0.55 + 0.45 * day);
    this.hemi.intensity = 0.07 + 0.33 * day;

    const fog = new THREE.Color().setHSL(0.58, 0.20 + 0.12 * (1 - day), 0.06 + 0.46 * day);
    this.scene.fog.color.copy(fog);
    this.renderer.setClearColor(fog);

    this.sky.material.uniforms.turbidity.value = 3.0 + 4 * (1 - day);
    this.sky.material.uniforms.rayleigh.value = 1.2 + 2.2 * day;

    this.isNight = elevation < 1;
    this._envDirty = true;
  }

  /** Suit la voiture : le ciel et la zone d'ombre restent centres sur elle. */
  update(target, dt) {
    this.sky.position.set(target.x, 0, target.z);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this._sunDir, 260);
    this.sun.target.updateMatrixWorld();

    if (this._envDirty) {
      this._envTimer -= dt;
      if (this._envTimer <= 0) {
        this._refreshEnvironment();
        this._envDirty = false;
        this._envTimer = 0.25;
      }
    }
  }

  _refreshEnvironment() {
    if (this.scene.environment) this.scene.environment.dispose();
    this._envScene.add(this.sky);
    const rt = this.pmrem.fromScene(this._envScene, 0.04);
    this.scene.add(this.sky);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.42;
  }

  dispose() {
    this.pmrem.dispose();
  }
}

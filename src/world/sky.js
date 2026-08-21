// Ciel, soleil, brume et carte d'environnement. L'heure du jour pilote tout d'un coup.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const SHADOW_EXTENT = 90; // demi-largeur de la zone d'ombre portee, en metres

export class Atmosphere {
  constructor(scene, renderer, {
    hour = 10,
    fogDistance = 2800,
    shadows = true,
    shadowMapSize = 2048,
    shadowExtent = SHADOW_EXTENT,
  } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.fogDistance = fogDistance;
    this.shadowsEnabled = shadows;

    this.sky = new Sky();
    this.sky.scale.setScalar(600000);
    this.sky.material.uniforms.turbidity.value = 8.0;
    this.sky.material.uniforms.rayleigh.value = 1.4;
    this.sky.material.uniforms.mieCoefficient.value = 0.005;
    this.sky.material.uniforms.mieDirectionalG.value = 0.8;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 600;
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);

    // Le ciel eclaire reellement le sol en bleu, mais dose trop fort cela delave
    // toute la scene : la moitie "sol" est volontairement chaude pour compenser.
    this.hemi = new THREE.HemisphereLight(0x93b2d8, 0x7a6c52, 0.6);
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
    this.sun.intensity = 0.05 + 1.25 * day;
    this.sun.color.setHSL(0.09 + 0.03 * day, 0.55 - 0.4 * day, 0.55 + 0.45 * day);
    this.hemi.intensity = 0.03 + 0.10 * day;

    const fog = new THREE.Color().setHSL(0.58, 0.26 + 0.10 * (1 - day), 0.05 + 0.34 * day);
    this.scene.fog.color.copy(fog);
    this.renderer.setClearColor(fog);

    this.sky.material.uniforms.turbidity.value = 6.0 + 5 * (1 - day);
    this.sky.material.uniforms.rayleigh.value = 0.8 + 1.1 * day;

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
    this.scene.environmentIntensity = 0.22;
  }

  dispose() {
    this.pmrem.dispose();
  }
}

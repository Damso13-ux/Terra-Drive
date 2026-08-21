// Commandes tactiles.
//
// Direction : le gyroscope est le mode par defaut, mains libres. Des que le doigt
// touche la moitie gauche de l'ecran, un volant apparait sous ce doigt et prend la
// main ; au relachement il s'efface et l'inclinaison reprend. Aucun element de
// direction n'occupe l'ecran en permanence.

const MAX_TILT = 26; // degres d'inclinaison pour un braquage complet
const TILT_DEADZONE = 1.6; // degres ignores autour du centre
const WHEEL_TRAVEL = 105; // pixels de glissement pour un braquage complet
const WHEEL_FADE = 0.28; // secondes de disparition du volant

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class TouchControls {
  constructor(root, actions = {}) {
    this.actions = actions;
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

    this.gyro = {
      supported: 'DeviceOrientationEvent' in window,
      enabled: false,
      needsPermission: typeof DeviceOrientationEvent?.requestPermission === 'function',
      tilt: 0,
      center: null,
      steer: 0,
    };

    this.wheel = { active: false, pointerId: null, originX: 0, value: 0, fade: 0 };
    this.pedals = { throttle: false, brake: false, handbrake: false };

    root.innerHTML = `
      <div class="tc-buttons">
        <button class="tc-btn" data-act="respawn" aria-label="Se replacer sur la route">&#10227;</button>
        <button class="tc-btn" data-act="camera" aria-label="Changer de camera">&#9635;</button>
        <button class="tc-btn" data-act="menu" aria-label="Menu">&#9776;</button>
      </div>

      <div class="tc-steer-zone" data-steer-zone></div>
      <div class="tc-wheel" data-wheel>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="43" fill="none" stroke="currentColor" stroke-width="7"/>
          <circle cx="50" cy="50" r="11" fill="currentColor"/>
          <path d="M50 39 L50 18 M39.5 55 L21 68 M60.5 55 L79 68"
                stroke="currentColor" stroke-width="7" stroke-linecap="round" fill="none"/>
        </svg>
      </div>

      <div class="tc-pedals">
        <button class="tc-pedal tc-brake" data-pedal="brake" aria-label="Freiner">FREIN</button>
        <button class="tc-pedal tc-gas" data-pedal="throttle" aria-label="Accelerer">GAZ</button>
      </div>
      <button class="tc-pedal tc-hand" data-pedal="handbrake" aria-label="Frein a main">&#9209;</button>

      <div class="tc-menu" data-menu>
        <button data-act="lights">Phares</button>
        <button data-act="time">Heure suivante</button>
        <button data-act="assists">Aides de conduite</button>
        <button data-act="recenter">Recentrer l'inclinaison</button>
        <button data-act="diag">Diagnostic</button>
        <button data-act="place">Changer de lieu</button>
        <button data-act="close" class="tc-menu-close">Fermer</button>
      </div>

      <div class="tc-gyro-prompt" data-gyro-prompt>
        <span>Diriger en inclinant le telephone&nbsp;?</span>
        <button data-act="gyro-on">Activer</button>
        <button data-act="gyro-off" class="ghost">Non merci</button>
      </div>
    `;

    this.root = root;
    this.wheelEl = root.querySelector('[data-wheel]');
    this.menuEl = root.querySelector('[data-menu]');
    this.gyroPromptEl = root.querySelector('[data-gyro-prompt]');
    this.steerZone = root.querySelector('[data-steer-zone]');

    this._bindPedals();
    this._bindSteering();
    this._bindButtons();
  }

  show() {
    this.root.classList.add('visible');
    if (this.gyro.supported) this.gyroPromptEl.classList.add('visible');
  }

  // -------------------------------------------------------------- pedales

  _bindPedals() {
    for (const el of this.root.querySelectorAll('[data-pedal]')) {
      const key = el.dataset.pedal;
      const press = (e) => {
        e.preventDefault();
        this.pedals[key] = true;
        el.classList.add('pressed');
        try { el.setPointerCapture?.(e.pointerId); } catch { /* pointeur deja relache */ }
      };
      const release = () => {
        this.pedals[key] = false;
        el.classList.remove('pressed');
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // ------------------------------------------------------------ direction

  _bindSteering() {
    const zone = this.steerZone;

    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.wheel.active) return;
      this.wheel.active = true;
      this.wheel.pointerId = e.pointerId;
      this.wheel.originX = e.clientX;
      this.wheel.value = 0;
      this.wheel.fade = 1;
      try { zone.setPointerCapture(e.pointerId); } catch { /* pointeur deja relache */ }
      this.wheelEl.style.left = e.clientX + 'px';
      this.wheelEl.style.top = e.clientY + 'px';
      this.wheelEl.classList.add('visible');
    });

    zone.addEventListener('pointermove', (e) => {
      if (!this.wheel.active || e.pointerId !== this.wheel.pointerId) return;
      const dx = e.clientX - this.wheel.originX;
      this.wheel.value = clamp(dx / WHEEL_TRAVEL, -1, 1);
      this.wheelEl.style.transform =
        `translate(-50%, -50%) rotate(${(this.wheel.value * 115).toFixed(1)}deg)`;
    });

    const end = (e) => {
      if (!this.wheel.active || e.pointerId !== this.wheel.pointerId) return;
      this.wheel.active = false;
      this.wheel.pointerId = null;
      this.wheelEl.classList.remove('visible');
      // le braquage revient a zero pendant la disparition, sans a-coup
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------------- boutons

  _bindButtons() {
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'menu') {
        this.menuEl.classList.toggle('visible');
        return;
      }
      if (act === 'close') {
        this.menuEl.classList.remove('visible');
        return;
      }
      if (act === 'gyro-on') {
        this.enableGyro();
        this.gyroPromptEl.classList.remove('visible');
        return;
      }
      if (act === 'gyro-off') {
        this.gyroPromptEl.classList.remove('visible');
        this.actions.hint?.('Glisse le doigt a gauche de l\'ecran pour diriger');
        return;
      }
      if (act === 'recenter') {
        this.gyro.center = null; // sera recalibre au prochain evenement
        this.actions.hint?.('Inclinaison recentree');
        this.menuEl.classList.remove('visible');
        return;
      }
      this.menuEl.classList.remove('visible');
      this.actions[act]?.();
    });
  }

  /** iOS exige une autorisation explicite, demandee depuis un geste utilisateur. */
  async enableGyro() {
    if (!this.gyro.supported) {
      this.actions.hint?.('Inclinaison non disponible sur cet appareil');
      return false;
    }
    try {
      if (this.gyro.needsPermission) {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          this.actions.hint?.('Autorisation refusee : glisse le doigt pour diriger');
          return false;
        }
      }
    } catch {
      this.actions.hint?.('Inclinaison indisponible : glisse le doigt pour diriger');
      return false;
    }

    this.gyro.center = null;
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this.gyro.enabled = true;
    this.actions.hint?.('Incline le telephone pour diriger');
    return true;
  }

  _onOrientation = (e) => {
    if (e.beta === null && e.gamma === null) return;
    // L'axe qui correspond au geste de volant depend de la facon dont l'appareil
    // est tenu : en paysage c'est beta, en portrait c'est gamma.
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    let tilt;
    if (angle === 90) tilt = e.beta;
    else if (angle === 270 || angle === -90) tilt = -e.beta;
    else if (angle === 180) tilt = -e.gamma;
    else tilt = e.gamma;
    if (tilt === null || Number.isNaN(tilt)) return;

    // Premiere mesure = position de repos. Personne ne tient son telephone a plat.
    if (this.gyro.center === null) this.gyro.center = tilt;
    this.gyro.tilt = tilt;

    const delta = tilt - this.gyro.center;
    const sign = Math.sign(delta);
    const magnitude = Math.max(0, Math.abs(delta) - TILT_DEADZONE);
    this.gyro.steer = clamp((sign * magnitude) / (MAX_TILT - TILT_DEADZONE), -1, 1);
  };

  // --------------------------------------------------------------- sortie

  /** Ecrit les commandes tactiles dans l'etat partage avec le clavier. */
  apply(state, dt) {
    state.throttle = approach(state.throttle, this.pedals.throttle ? 1 : 0, dt * (this.pedals.throttle ? 5 : 8));
    state.brake = approach(state.brake, this.pedals.brake ? 1 : 0, dt * (this.pedals.brake ? 7 : 9));
    state.handbrake = this.pedals.handbrake ? 1 : 0;

    let target;
    if (this.wheel.active) {
      target = this.wheel.value;
      this.wheel.fade = 1;
    } else if (this.wheel.fade > 0) {
      // transition douce entre le volant relache et l'inclinaison
      this.wheel.fade = Math.max(0, this.wheel.fade - dt / WHEEL_FADE);
      const gyroSteer = this.gyro.enabled ? this.gyro.steer : 0;
      target = this.wheel.value * this.wheel.fade + gyroSteer * (1 - this.wheel.fade);
    } else {
      target = this.gyro.enabled ? this.gyro.steer : 0;
    }

    // meme lissage que la direction clavier : la voiture ne doit jamais recevoir
    // un a-coup de braquage instantane
    state.steer = approach(state.steer, target, dt * 7);
    return state;
  }
}

const approach = (v, target, rate) => {
  const d = target - v;
  const step = Math.min(Math.abs(d), Math.max(rate, 0));
  return v + Math.sign(d) * step;
};

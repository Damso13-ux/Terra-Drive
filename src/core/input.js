// Clavier (AZERTY et QWERTY) + manette. Les gachettes analogiques sont prises telles
// quelles ; au clavier, l'accelerateur monte progressivement pour rester dosable.

const STEER_KEYS_LEFT = ['KeyA', 'KeyQ', 'ArrowLeft'];
const STEER_KEYS_RIGHT = ['KeyD', 'ArrowRight'];
const THROTTLE_KEYS = ['KeyW', 'KeyZ', 'ArrowUp'];
const BRAKE_KEYS = ['KeyS', 'ArrowDown'];

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.actions = new Map(); // code -> callback (appuis simples)
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.gamepadIndex = null;
    this.touch = null;
    this.enabled = true;

    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (!e.repeat) {
        const cb = this.actions.get(e.code);
        if (cb) cb();
      }
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    target.addEventListener('keydown', this._onDown);
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', (e) => (this.gamepadIndex = e.gamepad.index));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadIndex = null));
  }

  on(code, callback) {
    this.actions.set(code, callback);
  }

  /** Sur mobile, le tactile devient la source principale. */
  setTouch(touchControls) {
    this.touch = touchControls;
  }

  any(codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  update(dt) {
    const s = this.state;
    if (!this.enabled) {
      s.throttle = s.brake = s.steer = s.handbrake = 0;
      return s;
    }

    const up = this.any(THROTTLE_KEYS);
    const down = this.any(BRAKE_KEYS);
    const left = this.any(STEER_KEYS_LEFT);
    const right = this.any(STEER_KEYS_RIGHT);

    s.throttle = approach(s.throttle, up ? 1 : 0, dt * (up ? 3.2 : 6));
    s.brake = approach(s.brake, down ? 1 : 0, dt * (down ? 5 : 8));
    const steerTarget = (right ? 1 : 0) - (left ? 1 : 0);
    s.steer = approach(s.steer, steerTarget, dt * (steerTarget === 0 ? 6 : 3.6));
    s.handbrake = this.keys.has('Space') ? 1 : 0;

    if (this.touch) this.touch.apply(s, dt);
    this._applyGamepad(s);
    return s;
  }

  _applyGamepad(s) {
    if (this.gamepadIndex === null || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return;
    const axis = deadzone(pad.axes[0] ?? 0, 0.08);
    const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
    const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
    if (Math.abs(axis) > 0.001) s.steer = axis;
    if (rt > 0.01) s.throttle = rt;
    if (lt > 0.01) s.brake = lt;
    if (pad.buttons[0] && pad.buttons[0].pressed) s.handbrake = 1;
  }
}

const approach = (v, target, rate) => {
  const d = target - v;
  const step = Math.min(Math.abs(d), Math.max(rate, 0));
  return v + Math.sign(d) * step;
};

const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));

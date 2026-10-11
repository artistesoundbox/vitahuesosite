// Unified input: keyboard + mouse, Xbox-style gamepad, and touch controls.
//
// Everything is normalised into a single shape the game reads each frame:
//   move   { forward, strafe, sprint }   -1..1
//   firing boolean
//   look   pixel-equivalent deltas, consumed once per frame
//   actions  edge-triggered ('kick' | 'reload' | 'mute' | 'pause')

const STICK_DEADZONE = 0.18;
const TRIGGER_THRESHOLD = 0.4;
const SPRINT_STICK = 0.85;

// Right-stick pixels per second at full deflection, so one sensitivity works
// for mouse, pad and touch alike.
const PAD_LOOK_SPEED = 620;
const TOUCH_STICK_RADIUS = 56;

export class InputManager {
  constructor({ canvas, isLocked = () => false }) {
    this.canvas = canvas;
    this.isLocked = isLocked;

    this.move = { forward: 0, strafe: 0, sprint: false };
    // Firing is a union of sources; a connected pad must not stomp a touch hold.
    this.firingState = { mouse: false, pad: false, touch: false };
    this.look = { dx: 0, dy: 0 };
    this.actions = [];

    this.keys = Object.create(null);
    this.gamepadConnected = false;
    this.gamepadName = '';
    this.gamepadActive = false;
    this.touchMode = false;
    this._padUsed = false;
    this._padIdle = 0;
    this._touchPointers = 0;
    this._padButtons = [];

    this._stickPointerId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._lookPointerId = null;
    this._lookLast = { x: 0, y: 0 };
    this._lookMoved = false;

    this._bind();
  }

  /**
   * True when the game can run without a captured mouse pointer.
   *
   * Deliberately based on stable facts (a pad has been used, or touch controls
   * exist) rather than the momentary active source, so an idle stick never
   * pauses the match mid-fight.
   */
  get pointerFree() { return this.touchMode || this._padUsed; }

  /** True while a finger is on the on-screen controls. */
  get touchDriving() { return this._touchPointers > 0; }

  get firing() {
    const f = this.firingState;
    return f.mouse || f.pad || f.touch;
  }

  releaseFiring() {
    this.firingState.mouse = false;
    this.firingState.pad = false;
    this.firingState.touch = false;
  }

  _push(action) {
    if (!this.actions.includes(action)) this.actions.push(action);
  }

  takeActions() {
    const list = this.actions;
    this.actions = [];
    return list;
  }

  consumeLook() {
    const dx = this.look.dx;
    const dy = this.look.dy;
    this.look.dx = 0;
    this.look.dy = 0;
    return { dx, dy };
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { this.keys[e.code] = true; return; }
      this.keys[e.code] = true;
      if (e.code === 'KeyR') this._push('reload');
      if (e.code === 'KeyF' || e.code === 'Space') this._push('kick');
      if (e.code === 'KeyM') this._push('mute');
      if (e.code === 'Escape') this._push('pause');
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => {
      this.keys = Object.create(null);
      this.releaseFiring();
    });

    // Mouse look and fire only while the pointer is captured, so the click that
    // grabs the pointer doesn't immediately fire a shot.
    window.addEventListener('mousemove', (e) => {
      if (!this.isLocked() || this.pointerFree) return;
      this.look.dx += e.movementX;
      this.look.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.isLocked()) this.firingState.mouse = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firingState.mouse = false;
    });

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadConnected = true;
      this.gamepadName = e.gamepad.id || 'gamepad';
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadConnected = false;
      this.gamepadActive = false;
      this._padUsed = false;
    });

    // Show touch controls as soon as a touch is seen, or on coarse-pointer devices.
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse) this.enableTouch();
    window.addEventListener('touchstart', () => this.enableTouch(), { once: true, passive: true });
  }

  /** Returns the first connected gamepad, if any. */
  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) if (pad && pad.connected) return pad;
    return null;
  }

  update(dt) {
    this._updateGamepad(dt);
    // Whatever moved most recently owns movement; keyboard is the fallback.
    if (!this.gamepadActive && !this.touchDriving) this._applyKeys();
  }

  _applyKeys() {
    const k = this.keys;
    const forward = (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0);
    const strafe = (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);
    this.move.forward = forward;
    this.move.strafe = strafe;
    this.move.sprint = Boolean(k['ShiftLeft'] || k['ShiftRight']);
  }

  _updateGamepad(dt) {
    const pad = this._gamepad();
    if (!pad) {
      this.gamepadConnected = false;
      return;
    }
    this.gamepadConnected = true;
    if (!this.gamepadName) this.gamepadName = pad.id || 'gamepad';

    const ax = pad.axes || [];
    const lx = ax[0] || 0;
    const ly = ax[1] || 0;
    const rx = ax[2] || 0;
    const ry = ax[3] || 0;
    const buttons = pad.buttons || [];
    const pressed = (i) => Boolean(buttons[i] && buttons[i].pressed === true);
    const value = (i) => (buttons[i] && typeof buttons[i].value === 'number' ? buttons[i].value : 0);

    const lMag = Math.hypot(lx, ly);
    const rMag = Math.hypot(rx, ry);
    const rt = value(7);
    const lt = value(6);

    const activity = lMag > STICK_DEADZONE || rMag > STICK_DEADZONE || rt > 0.15 || lt > 0.15
      || buttons.some((b) => b && b.pressed);
    if (activity) {
      this.gamepadActive = true;
      this._padUsed = true;
      this._padIdle = 0;
    } else {
      // Hand movement back to the keyboard shortly after the stick goes quiet.
      this._padIdle += dt;
      if (this._padIdle > 1.5) this.gamepadActive = false;
    }

    // Movement
    const dz = (v) => (Math.abs(v) < STICK_DEADZONE ? 0 : (v - Math.sign(v) * STICK_DEADZONE) / (1 - STICK_DEADZONE));
    this.move.strafe = dz(lx);
    this.move.forward = -dz(ly); // stick up is negative on the Y axis
    this.move.sprint = lMag > SPRINT_STICK || pressed(10) || lt > 0.5;

    // Look
    if (rMag > STICK_DEADZONE) {
      this.look.dx += dz(rx) * PAD_LOOK_SPEED * dt;
      this.look.dy += dz(ry) * PAD_LOOK_SPEED * dt;
    }

    // Fire (analog trigger)
    this.firingState.pad = rt > TRIGGER_THRESHOLD;

    // Edge-triggered buttons
    const edge = (i, action) => {
      const now = pressed(i);
      if (now && !this._padButtons[i]) this._push(action);
      this._padButtons[i] = now;
    };
    edge(0, 'kick');    // A
    edge(1, 'reload');  // B
    edge(2, 'mute');    // X
    edge(9, 'pause');   // Menu
  }

  // ------------------------------------------------------------------ touch

  enableTouch() {
    if (this.touchMode) return;
    this.touchMode = true;
    document.body.classList.add('touch-mode');
    this._bindTouch();
  }

  _bindTouch() {
    const stick = document.getElementById('touch-stick');
    const knob = document.getElementById('touch-knob');
    const lookZone = document.getElementById('touch-look');
    if (!stick || !knob || !lookZone) return;

    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const centreStick = () => {
      setKnob(0, 0);
      this.move.forward = 0;
      this.move.strafe = 0;
      this.move.sprint = false;
    };
    centreStick();

    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._touchPointers++;
      this._stickPointerId = e.pointerId;
      const rect = stick.getBoundingClientRect();
      this._stickOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      // Record state before capturing: capture can throw and must not skip setup.
      try { stick.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      this._moveStick(e.clientX, e.clientY, setKnob);
    });

    stick.addEventListener('pointermove', (e) => {
      if (this._stickPointerId !== e.pointerId) return;
      e.preventDefault();
      this._moveStick(e.clientX, e.clientY, setKnob);
    });

    const endStick = (e) => {
      if (this._stickPointerId !== e.pointerId) return;
      this._stickPointerId = null;
      this._touchPointers = Math.max(0, this._touchPointers - 1);
      centreStick();
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    // Aim by dragging anywhere on the right side that isn't a button.
    lookZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._touchPointers++;
      this._lookPointerId = e.pointerId;
      this._lookLast = { x: e.clientX, y: e.clientY };
      this._lookMoved = false;
      try { lookZone.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    });
    lookZone.addEventListener('pointermove', (e) => {
      if (this._lookPointerId !== e.pointerId) return;
      e.preventDefault();
      const dx = e.clientX - this._lookLast.x;
      const dy = e.clientY - this._lookLast.y;
      this._lookLast = { x: e.clientX, y: e.clientY };
      if (Math.abs(dx) + Math.abs(dy) > 1) this._lookMoved = true;
      this.look.dx += dx * 1.35;
      this.look.dy += dy * 1.35;
    });
    const endLook = (e) => {
      if (this._lookPointerId !== e.pointerId) return;
      this._lookPointerId = null;
      this._touchPointers = Math.max(0, this._touchPointers - 1);
    };
    lookZone.addEventListener('pointerup', endLook);
    lookZone.addEventListener('pointercancel', endLook);

    const hold = (id, on, off) => {
      const el = document.getElementById(id);
      if (!el) return;
      let down = false;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (down) return;
        down = true;
        this._touchPointers++;
        try { el.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
        el.classList.add('pressed');
        on();
      });
      const release = (e) => {
        e.preventDefault();
        if (!down) return;
        down = false;
        this._touchPointers = Math.max(0, this._touchPointers - 1);
        el.classList.remove('pressed');
        if (off) off();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    };

    hold('touch-fire', () => { this.firingState.touch = true; }, () => { this.firingState.touch = false; });
    hold('touch-kick', () => this._push('kick'));
    hold('touch-reload', () => this._push('reload'));
  }

  _moveStick(clientX, clientY, setKnob) {
    let dx = clientX - this._stickOrigin.x;
    let dy = clientY - this._stickOrigin.y;
    const mag = Math.hypot(dx, dy);
    if (mag > TOUCH_STICK_RADIUS) {
      dx = (dx / mag) * TOUCH_STICK_RADIUS;
      dy = (dy / mag) * TOUCH_STICK_RADIUS;
    }
    setKnob(dx, dy);
    const nx = dx / TOUCH_STICK_RADIUS;
    const ny = dy / TOUCH_STICK_RADIUS;
    this.move.strafe = nx;
    this.move.forward = -ny;
    this.move.sprint = Math.hypot(nx, ny) > SPRINT_STICK;
  }

}

/**
 * The room.
 *
 * Loads the Blender export (tvroom.glb), lights it, and turns the television
 * panel into a live surface: the player's <video> becomes a VideoTexture on a
 * plane sitting just in front of Plane.005. When no stream is running the
 * screen falls back to a "no signal" canvas so the room never looks broken.
 *
 * Looking around is a drag: yaw and pitch are eased toward what the pointer
 * asks for, with generous but finite limits so you stay in the room.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Where you stand (glTF space: Y up, the room's Blender axes rotated by the
// exporter). Just behind the coffee table, sofa at your back, TV ahead.
const SEAT = new THREE.Vector3(8.4, 6.3, -4.6);
const LOOK_AT = new THREE.Vector3(-10.36, 5.7, -3.7);

const YAW_LIMIT = 1.15;      // radians left/right of the TV
const PITCH_UP = 0.42;
const PITCH_DOWN = 0.5;
const DRAG_SENSITIVITY = 0.0032;

const NOISE_W = 320;
const NOISE_H = 180;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export class TvRoom {
  constructor({ canvas, video, onOpenViewer }) {
    this.canvas = canvas;
    this.onOpenViewer = onOpenViewer || (() => {});
    this.signal = 'offline';
    this._noiseAccumulator = 0;
    this._running = false;
    this._dragging = false;
    this._moved = 0;
    this._pointerId = null;
    this._start = { x: 0, y: 0, yaw: 0, pitch: 0 };

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);
    this.scene = scene;

    const pmrem = new THREE.PMREMGenerator(renderer);
    this._envTarget = pmrem.fromScene(new RoomEnvironment(), 0.05);
    scene.environment = this._envTarget.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 400);
    camera.position.copy(SEAT);
    camera.rotation.order = 'YXZ';
    this.camera = camera;

    const dir = LOOK_AT.clone().sub(SEAT).normalize();
    this.baseYaw = Math.atan2(-dir.x, -dir.z);
    this.basePitch = Math.asin(clamp(dir.y, -1, 1));
    this.yaw = this.baseYaw;
    this.pitch = this.basePitch;
    this.targetYaw = this.baseYaw;
    this.targetPitch = this.basePitch;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    this._buildVideoTexture(video);
    this._buildNoise();
    this._buildLights();
    this._bindEvents();

    this._clock = new THREE.Clock();
    this.resize();
    this._loop = this._loop.bind(this);
    this.start();
  }

  _buildVideoTexture(video) {
    this.video = video;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.videoTexture = texture;
  }

  _buildNoise() {
    const canvas = document.createElement('canvas');
    canvas.width = NOISE_W;
    canvas.height = NOISE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    this._noiseCanvas = canvas;
    this._noiseCtx = ctx;
    this._noiseImage = ctx.createImageData(NOISE_W, NOISE_H);
    this._drawNoise();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.noiseTexture = texture;
  }

  _drawNoise() {
    const ctx = this._noiseCtx;
    const img = this._noiseImage;
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = 12 + Math.random() * 88;
      data[i] = v * 0.72;
      data[i + 1] = v * 0.86;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    for (let y = 0; y < NOISE_H; y += 3) ctx.fillRect(0, y, NOISE_W, 1);

    // rolling bright band
    const bandY = (this._noisePhase = ((this._noisePhase || 0) + 7) % (NOISE_H + 60)) - 30;
    const grad = ctx.createLinearGradient(0, bandY, 0, bandY + 60);
    grad.addColorStop(0, 'rgba(150, 195, 255, 0)');
    grad.addColorStop(0.5, 'rgba(150, 195, 255, 0.10)');
    grad.addColorStop(1, 'rgba(150, 195, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandY, NOISE_W, 60);

    ctx.fillStyle = 'rgba(198, 226, 255, 0.92)';
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('NO SIGNAL', NOISE_W / 2, NOISE_H / 2 + 5);
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = 'rgba(150, 180, 210, 0.7)';
    ctx.fillText('PRESS  VIEW TV', NOISE_W / 2, NOISE_H / 2 + 22);

    if (this.noiseTexture) this.noiseTexture.needsUpdate = true;
  }

  _buildLights() {
    const scene = this.scene;

    // Warm pendants over the seating area
    const pendantA = new THREE.PointLight(0xffd7ae, 260, 70, 2);
    pendantA.position.set(-1.5, 17.5, -6);
    scene.add(pendantA);

    const pendantB = new THREE.PointLight(0xffd7ae, 190, 60, 2);
    pendantB.position.set(4, 17.5, -16);
    scene.add(pendantB);

    // Cooler fill from the window side so the textures keep their shape
    const fill = new THREE.DirectionalLight(0xbcd8ff, 0.55);
    fill.position.set(24, 18, 6);
    fill.target.position.set(-6, 6, -4);
    scene.add(fill);
    scene.add(fill.target);

    const rim = new THREE.PointLight(0x8fb8ff, 60, 46, 2);
    rim.position.set(14, 12, 10);
    scene.add(rim);

    // The television itself throws light into the room
    const glow = new THREE.PointLight(0x9fc4ff, 70, 26, 2);
    glow.position.set(-9.1, 5.9, -3.7);
    scene.add(glow);
    this.screenLight = glow;
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url, (event) => {
      if (!onProgress) return;
      const total = event.total || 0;
      onProgress(total ? event.loaded / total : 0);
    });
    const root = gltf.scene;
    this.scene.add(root);
    this._buildScreen(root);
    return root;
  }

  _buildScreen(root) {
    let panel =
      root.getObjectByName('Plane.005') ||
      root.getObjectByName('Plane005') ||
      root.getObjectByName('Plane_005');

    if (!panel) {
      root.traverse((obj) => {
        if (panel || !obj.isMesh) return;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        if (materials.some((m) => m && /Material\.?005/.test(m.name || ''))) panel = obj;
      });
    }

    const box = new THREE.Box3();
    if (panel) {
      box.setFromObject(panel);
    } else {
      // Known panel bounds from the Blender scene, as a last resort.
      box.min.set(-10.52, 4.33, -6.31);
      box.max.set(-10.36, 7.45, -1.05);
    }

    const width = Math.max(0.01, box.max.z - box.min.z);
    const height = Math.max(0.01, box.max.y - box.min.y);

    const geometry = new THREE.PlaneGeometry(width * 0.988, height * 0.985);
    const material = new THREE.MeshBasicMaterial({
      map: this.noiseTexture,
      toneMapped: false,
    });
    const screen = new THREE.Mesh(geometry, material);
    screen.position.set(
      box.max.x + 0.02,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2
    );
    // PlaneGeometry faces +Z; turn it to face +X, into the room.
    screen.rotation.y = Math.PI / 2;
    screen.name = 'TvScreen';
    this.scene.add(screen);

    this.screen = screen;
    this.screenMaterial = material;
    this.screenLight.position.set(box.max.x + 1.1, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
  }

  /** 'live' shows the video; anything else shows the no-signal card. */
  setSignal(state) {
    this.signal = state === 'live' ? 'live' : 'offline';
    if (!this.screenMaterial) return;
    this.screenMaterial.map = this.signal === 'live' ? this.videoTexture : this.noiseTexture;
    this.screenMaterial.needsUpdate = true;
  }

  _bindEvents() {
    const canvas = this.canvas;

    this._onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      this._dragging = true;
      this._moved = 0;
      this._pointerId = event.pointerId;
      this._start = { x: event.clientX, y: event.clientY, yaw: this.targetYaw, pitch: this.targetPitch };
      canvas.classList.add('is-dragging');
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* some browsers refuse without a touch */
      }
    };

    this._onPointerMove = (event) => {
      if (!this._dragging) return;
      const dx = event.clientX - this._start.x;
      const dy = event.clientY - this._start.y;
      this._moved = Math.max(this._moved, Math.hypot(dx, dy));
      this.targetYaw = clamp(
        this._start.yaw + dx * DRAG_SENSITIVITY,
        this.baseYaw - YAW_LIMIT,
        this.baseYaw + YAW_LIMIT
      );
      this.targetPitch = clamp(
        this._start.pitch + dy * DRAG_SENSITIVITY * 0.85,
        this.basePitch - PITCH_UP,
        this.basePitch + PITCH_DOWN
      );
    };

    this._onPointerUp = (event) => {
      if (!this._dragging) return;
      this._dragging = false;
      canvas.classList.remove('is-dragging');
      if (this._pointerId !== null) {
        try {
          canvas.releasePointerCapture(this._pointerId);
        } catch {
          /* already released */
        }
        this._pointerId = null;
      }
      if (this._moved < 6) this._maybeOpen(event.clientX, event.clientY);
    };

    this._onPointerCancel = () => {
      this._dragging = false;
      canvas.classList.remove('is-dragging');
    };

    this._onResize = () => this.resize();
    this._onVisibility = () => {
      if (document.hidden) this.stop();
      else this.start();
    };

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _maybeOpen(clientX, clientY) {
    if (!this.screen) return;
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.camera);
    if (this._raycaster.intersectObject(this.screen, false).length) this.onOpenViewer();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);

    const dt = Math.min(0.05, this._clock.getDelta());

    const ease = 1 - Math.pow(0.001, dt); // frame-rate independent damping
    this.yaw += (this.targetYaw - this.yaw) * ease;
    this.pitch += (this.targetPitch - this.pitch) * ease;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    if (this.signal === 'offline') {
      this._noiseAccumulator += dt;
      if (this._noiseAccumulator > 0.1) {
        this._noiseAccumulator = 0;
        this._drawNoise();
      }
    }

    // A little life in the TV's spill: it breathes with the picture.
    if (this.screenLight) {
      const base = this.signal === 'live' ? 78 : 26;
      const wobble = Math.sin(now * 0.0018) * 0.08 + Math.sin(now * 0.0007) * 0.06;
      this.screenLight.intensity = base * (1 + wobble);
      this.screenLight.color.setHex(this.signal === 'live' ? 0x9fc4ff : 0x6c7f99);
    }

    this.renderer.render(this.scene, this.camera);
  }
}

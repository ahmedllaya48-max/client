import * as THREE from 'three';

const ARENA_R = 60;
const FOOD_N = 70;
const BEST_KEY = 'doda_best_v1';
const NAME_KEY = 'doda_name_v1';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
function angLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// Texturas procedurais (sem assets externos: nada de copyright, tudo gerado)
function canvasTex(size, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}
function soilTexture() {
  return canvasTex(512, (g, s) => {
    g.fillStyle = '#5d7f36'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = 1 + Math.random() * 5;
      const tones = ['#52742f', '#68893d', '#4d6e2c', '#749647', '#5a7c33'];
      g.fillStyle = tones[(Math.random() * tones.length) | 0];
      g.globalAlpha = 0.25 + Math.random() * 0.4;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    g.globalAlpha = 0.5;
    for (let i = 0; i < 900; i++) {
      g.strokeStyle = Math.random() < 0.5 ? '#3f6126' : '#7fa04e';
      const x = Math.random() * s, y = Math.random() * s;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 4, y - 2 - Math.random() * 4); g.stroke();
    }
    g.globalAlpha = 1;
  }, 10);
}
function skinTexture(base, stripe) {
  return canvasTex(128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = stripe;
    for (let y = 0; y < s; y += 16) g.fillRect(0, y, s, 6);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 0, s * 0.35, s);
  });
}
function stoneTexture() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#8d8d94'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 500; i++) {
      g.fillStyle = ['#7c7c83', '#9b9ba2', '#6f6f76'][(Math.random() * 3) | 0];
      g.globalAlpha = 0.5;
      g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 2 + Math.random() * 8, 0, TAU); g.fill();
    }
    g.globalAlpha = 1;
  }, 6);
}

// Áudio 100% procedural (WebAudio, sem arquivos)
const Sound = {
  ctx: null, muted: false,
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sem áudio */ } }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  blip(freq, dur, type, vol) {
    if (this.muted || !this.ctx) return;
    try {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.15, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + dur);
    } catch { /* ignora */ }
  },
  eat(big) { this.blip(big ? 660 : 520 + Math.random() * 120, 0.12, 'triangle', 0.18); },
  death() { this.blip(160, 0.5, 'sawtooth', 0.2); setTimeout(() => this.blip(90, 0.6, 'sawtooth', 0.18), 120); },
  click() { this.blip(440, 0.06, 'square', 0.08); },
};

const SKINS = [
  { name: 'خضراء', base: '#4caf50', stripe: '#2e7d32', glow: 0x7bff9e },
  { name: 'زرقاء', base: '#42a5f5', stripe: '#1565c0', glow: 0x9fd8ff },
  { name: 'برتقالية', base: '#ff9800', stripe: '#e65100', glow: 0xffd54f },
  { name: 'بنفسجية', base: '#ab47bc', stripe: '#6a1b9a', glow: 0xe1bee7 },
];
const DIFFS = {
  easy: { label: 'سهلة', bots: 3, botSpeed: 5.2, botTurn: 2.2 },
  mid: { label: 'متوسطة', bots: 4, botSpeed: 6.2, botTurn: 3.0 },
  hard: { label: 'صعبة', bots: 5, botSpeed: 7.2, botTurn: 3.8 },
};

class Worm {
  constructor(scene, opts) {
    this.scene = scene;
    this.name = opts.name || 'دودة';
    this.isBot = !!opts.isBot;
    this.skin = opts.skin || 0;
    this.baseSpeed = opts.speed || 7;
    this.speed = this.baseSpeed;
    this.turnRate = opts.turn || 3.2;
    this.angle = Math.random() * TAU;
    this.score = 0;
    this.segGap = 0.85;
    this.bodyR = 0.55;
    this.alive = true;
    this.boosting = false;
    this.wanderT = 0;
    this.targetAngle = this.angle;
    const a = Math.random() * TAU, r = 10 + Math.random() * (ARENA_R - 22);
    this.head = new THREE.Vector3(Math.cos(a) * r, 0.7, Math.sin(a) * r);
    this.points = [this.head.clone()];
    const n0 = 10;
    for (let i = 1; i < n0; i++) {
      this.points.push(new THREE.Vector3(
        this.head.x - Math.cos(this.angle) * this.segGap * i, 0.7,
        this.head.z - Math.sin(this.angle) * this.segGap * i));
    }
    const sk = SKINS[this.skin % SKINS.length];
    this.mat = new THREE.MeshStandardMaterial({
      map: skinTexture(sk.base, sk.stripe), roughness: 0.32, metalness: 0.05,
    });
    this.geo = new THREE.SphereGeometry(1, 14, 12);
    this.meshes = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 }));
    this.eyeW2 = this.eyeW.clone();
    this.pupilG = new THREE.SphereGeometry(0.1, 8, 6);
    this.pupilM = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.1 });
    this.pupil = new THREE.Mesh(this.pupilG, this.pupilM);
    this.pupil2 = new THREE.Mesh(this.pupilG, this.pupilM);
    this.tongue = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 6),
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.4 }));
    this.tongue.rotation.x = Math.PI / 2;
    this.tongueT = Math.random() * 10;
    this.group.add(this.eyeW, this.eyeW2, this.pupil, this.pupil2, this.tongue);
    this.glowM = new THREE.MeshBasicMaterial({ color: sk.glow, transparent: true, opacity: 0.0 });
    this.syncMeshes();
  }
  get length() { return this.points.length; }
  get headR() { return this.bodyR + 0.15; }
  targetSegments() { return Math.min(70, 10 + Math.floor(this.score / 25)); }
  syncMeshes() {
    const want = this.targetSegments();
    while (this.meshes.length < want) {
      const m = new THREE.Mesh(this.geo, this.mat);
      m.castShadow = true;
      this.meshes.push(m); this.group.add(m);
    }
    while (this.points.length < want) {
      const last = this.points[this.points.length - 1];
      this.points.push(last.clone());
    }
  }
  steer(dt) {
    this.angle = angLerp(this.angle, this.targetAngle, Math.min(1, this.turnRate * dt));
  }
  move(dt, dropPellet) {
    const sp = this.boosting ? this.speed * 1.8 : this.speed;
    this.head.x += Math.cos(this.angle) * sp * dt;
    this.head.z += Math.sin(this.angle) * sp * dt;
    this.head.y = 0.7 + Math.sin(performance.now() * 0.004 + this.skin) * 0.05;
    this.points[0].copy(this.head);
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i], q = this.points[i - 1];
      const dx = q.x - p.x, dz = q.z - p.z;
      const d = Math.hypot(dx, dz) || 1e-5;
      const want = this.segGap;
      if (d > want) {
        p.x = q.x - (dx / d) * want;
        p.z = q.z - (dz / d) * want;
      }
      p.y = 0.7 - Math.min(0.25, i * 0.008) + Math.sin(performance.now() * 0.006 - i * 0.55) * 0.045;
    }
    if (this.boosting && !this.isBot && this.score > 0 && dropPellet) {
      this.boostDrain = (this.boostDrain || 0) + dt;
      if (this.boostDrain > 0.55 && this.points.length > 10) {
        this.boostDrain = 0;
        this.score = Math.max(0, this.score - 4);
        dropPellet(this.head.x - Math.cos(this.angle) * 1.5, this.head.z - Math.sin(this.angle) * 1.5, 4);
      }
    }
    this.bodyR = 0.55 + Math.min(0.45, this.score / 900);
  }
  render(t) {
    const n = this.points.length;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (i >= n) { m.visible = false; continue; }
      m.visible = true;
      const p = this.points[i];
      const taper = i === 0 ? 1.18 : Math.max(0.25, 1 - (i / n) * 0.85);
      const breathe = 1 + Math.sin(t * 5 - i * 0.5) * 0.045;
      const s = this.bodyR * taper * breathe;
      m.position.copy(p);
      m.scale.set(s, s * 0.92, s);
    }
    const fx = Math.cos(this.angle), fz = Math.sin(this.angle);
    const px = -fz, pz = fx;
    const hx = this.head.x, hy = this.head.y, hz = this.head.z;
    this.eyeW.position.set(hx + fx * 0.55 + px * 0.38, hy + 0.42, hz + fz * 0.55 + pz * 0.38);
    this.eyeW2.position.set(hx + fx * 0.55 - px * 0.38, hy + 0.42, hz + fz * 0.55 - pz * 0.38);
    this.pupil.position.set(hx + fx * 0.72 + px * 0.38, hy + 0.45, hz + fz * 0.72 + pz * 0.38);
    this.pupil2.position.set(hx + fx * 0.72 - px * 0.38, hy + 0.45, hz + fz * 0.72 - pz * 0.38);
    this.tongueT += 0.016;
    const flick = (this.tongueT % 2.4) < 0.5 ? 1 : 0.25;
    this.tongue.position.set(hx + fx * (1.1 * flick + 0.4), hy - 0.05, hz + fz * (1.1 * flick + 0.4));
    this.tongue.rotation.y = -this.angle;
    this.tongue.scale.setScalar(flick);
  }
  dispose() {
    this.scene.remove(this.group);
    this.geo.dispose(); this.mat.dispose();
  }
}

class FoodPool {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.appleG = new THREE.SphereGeometry(0.42, 14, 12);
    this.appleM = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.25 });
    this.leafG = new THREE.SphereGeometry(0.16, 8, 6);
    this.leafM = new THREE.MeshStandardMaterial({ color: 0x388e3c, roughness: 0.5 });
    this.stemG = new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6);
    this.stemM = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.8 });
    this.shroomCapG = new THREE.SphereGeometry(0.4, 12, 8, 0, TAU, 0, Math.PI / 2);
    this.shroomCapM = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.35 });
    this.shroomDotM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.shroomDotG = new THREE.SphereGeometry(0.07, 6, 5);
    this.stalkG = new THREE.CylinderGeometry(0.14, 0.18, 0.5, 8);
    this.stalkM = new THREE.MeshStandardMaterial({ color: 0xefebe9, roughness: 0.6 });
    this.orbG = new THREE.SphereGeometry(0.3, 12, 10);
  }
  randPos(margin) {
    const a = Math.random() * TAU, r = Math.random() * (ARENA_R - (margin || 4));
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }
  makeMesh(kind, value) {
    const g = new THREE.Group();
    if (kind === 1) {
      const apple = new THREE.Mesh(this.appleG, this.appleM);
      apple.position.y = 0.45; apple.castShadow = true;
      const stem = new THREE.Mesh(this.stemG, this.stemM);
      stem.position.y = 0.95;
      const leaf = new THREE.Mesh(this.leafG, this.leafM);
      leaf.position.set(0.18, 0.95, 0); leaf.scale.set(1.4, 0.5, 0.8);
      g.add(apple, stem, leaf);
    } else if (kind === 2) {
      const stalk = new THREE.Mesh(this.stalkG, this.stalkM);
      stalk.position.y = 0.25;
      const cap = new THREE.Mesh(this.shroomCapG, this.shroomCapM);
      cap.position.y = 0.5; cap.castShadow = true;
      g.add(stalk, cap);
      for (let i = 0; i < 3; i++) {
        const d = new THREE.Mesh(this.shroomDotG, this.shroomDotM);
        d.position.set((Math.random() - 0.5) * 0.4, 0.72, (Math.random() - 0.5) * 0.4);
        g.add(d);
      }
    } else {
      const hue = [0x7bff9e, 0xffd54f, 0x9fd8ff][value > 8 ? 2 : value > 5 ? 1 : 0];
      const orb = new THREE.Mesh(this.orbG, new THREE.MeshStandardMaterial({
        color: hue, emissive: hue, emissiveIntensity: 0.9, roughness: 0.3,
      }));
      orb.position.y = 0.4;
      g.add(orb);
    }
    return g;
  }
  add(x, z, kind, value) {
    if (kind === undefined) {
      const r = Math.random();
      kind = r < 0.62 ? 0 : r < 0.85 ? 1 : 2;
    }
    if (value === undefined) value = kind === 0 ? 3 + ((Math.random() * 4) | 0) : kind === 1 ? 12 : 20;
    const mesh = this.makeMesh(kind, value);
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    const it = { x, z, kind, value, mesh, ph: Math.random() * TAU };
    this.items.push(it);
    return it;
  }
  fill(n) { while (this.items.length < n) { const p = this.randPos(4); this.add(p.x, p.z); } }
  remove(it) {
    this.scene.remove(it.mesh);
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
  }
  update(t) {
    for (const it of this.items) {
      it.mesh.rotation.y = t * (it.kind === 0 ? 1.2 : 0.5) + it.ph;
      it.mesh.position.y = Math.abs(Math.sin(t * 1.6 + it.ph)) * 0.18;
    }
  }
}

class Burst {
  constructor(scene) {
    this.scene = scene;
    this.pools = [];
  }
  spawn(x, y, z, color, n, spread) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const a = Math.random() * TAU, e = Math.random() * Math.PI - Math.PI / 2;
      const s = (spread || 5) * (0.4 + Math.random() * 0.8);
      vel.push([Math.cos(a) * Math.cos(e) * s, Math.abs(Math.sin(e)) * s + 2, Math.sin(a) * Math.cos(e) * s]);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size: 0.35, transparent: true, opacity: 1 });
    const p = new THREE.Points(g, m);
    this.scene.add(p);
    this.pools.push({ p, vel, life: 0.9 });
  }
  update(dt) {
    for (let i = this.pools.length - 1; i >= 0; i--) {
      const b = this.pools[i];
      b.life -= dt;
      const arr = b.p.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        arr[j * 3] += b.vel[j][0] * dt;
        arr[j * 3 + 1] += b.vel[j][1] * dt;
        arr[j * 3 + 2] += b.vel[j][2] * dt;
        b.vel[j][1] -= 9 * dt;
        if (arr[j * 3 + 1] < 0.05) arr[j * 3 + 1] = 0.05;
      }
      b.p.geometry.attributes.position.needsUpdate = true;
      b.p.material.opacity = Math.max(0, b.life);
      if (b.life <= 0) {
        this.scene.remove(b.p);
        b.p.geometry.dispose(); b.p.material.dispose();
        this.pools.splice(i, 1);
      }
    }
  }
}

export const Game = {
  state: 'menu', worms: [], player: null,
  scene: null, camera: null, renderer: null,
  foods: null, bursts: null, clock: 0,
  keys: {}, pointerAngle: null, pointerT: 0,
  diffKey: 'mid', skinIdx: 0,
  minimap: null, lbTimer: 0,

  init() {
    const canvas = $('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87b5e0);
    this.scene.fog = new THREE.Fog(0x9fc3e2, 55, 160);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 500);
    this.camera.position.set(0, 12, 14);

    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a5d23, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d9, 1.9);
    sun.position.set(35, 55, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
    sun.shadow.camera.far = 160;
    this.scene.add(sun);

    // Céu: cúpula com gradiente (nascer do sol suave e realista)
    const skyGeo = new THREE.SphereGeometry(320, 16, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d6fb4) }, mid: { value: new THREE.Color(0x9fc3e2) }, bot: { value: new THREE.Color(0xf6d9a8) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; uniform vec3 top,mid,bot;' +
        'void main(){ float h = normalize(vP).y;' +
        ' vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.65, h)) : mix(bot, mid, smoothstep(-0.08, 0.12, h));' +
        ' gl_FragColor = vec4(c, 1.0); }',
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA_R + 26, 48),
      new THREE.MeshStandardMaterial({ map: soilTexture(), roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Muro de pedra: visto SEMPRE por dentro (câmera nunca sai da arena),
    // por isso BackSide — as normais apontam para dentro e a luz acerta.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R + 1.2, ARENA_R + 1.6, 2.4, 64, 1, true),
      new THREE.MeshStandardMaterial({ map: stoneTexture(), roughness: 0.9, side: THREE.BackSide }));
    wall.position.y = 1.2;
    this.scene.add(wall);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R + 1.2, 0.35, 10, 72),
      new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.7 }));
    rim.rotation.x = Math.PI / 2; rim.position.y = 2.5;
    this.scene.add(rim);

    // Grama instanced (leve e numerosa)
    {
      const gg = new THREE.ConeGeometry(0.09, 0.55, 4);
      const gm = new THREE.MeshStandardMaterial({ color: 0x3f7a28, roughness: 1 });
      const inst = new THREE.InstancedMesh(gg, gm, 900);
      const d = new THREE.Object3D();
      for (let i = 0; i < 900; i++) {
        const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * (ARENA_R + 20);
        d.position.set(Math.cos(a) * r, 0.25, Math.sin(a) * r);
        d.rotation.y = Math.random() * TAU;
        const s = 0.7 + Math.random() * 1.3;
        d.scale.set(s, s, s);
        d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
      }
      this.scene.add(inst);
    }
    // Pedras e flores
    const rockM = new THREE.MeshStandardMaterial({ color: 0x8a8d94, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 22; i++) {
      const p = this.randArena(5);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + Math.random() * 1.1, 0), rockM);
      rock.position.set(p.x, 0.3, p.z);
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      rock.castShadow = rock.receiveShadow = true;
      this.scene.add(rock);
    }
    const petalCols = [0xffffff, 0xffeb3b, 0xf48fb1, 0xce93d8];
    for (let i = 0; i < 36; i++) {
      const p = this.randArena(4);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5),
        new THREE.MeshStandardMaterial({ color: 0x2e7d32 }));
      st.position.set(p.x, 0.25, p.z);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6),
        new THREE.MeshStandardMaterial({
          color: petalCols[(Math.random() * petalCols.length) | 0],
          emissive: 0x222222, roughness: 0.5,
        }));
      fl.position.set(p.x, 0.55, p.z);
      this.scene.add(st, fl);
    }

    this.foods = new FoodPool(this.scene);
    this.bursts = new Burst(this.scene);
    this.minimap = $('minimap').getContext('2d');
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  },

  randArena(margin) {
    const a = Math.random() * TAU, r = Math.random() * (ARENA_R - (margin || 4));
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  },

  bindInput() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyP' || e.code === 'Escape') this.togglePause();
      if (e.code === 'KeyM') this.toggleMute();
      Sound.ensure();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    const cv = $('game-canvas');
    const toAngle = (cx, cy) => {
      if (!this.player || !this.player.alive) return;
      const r = cv.getBoundingClientRect();
      const nx = ((cx - r.left) / r.width) * 2 - 1;
      const ny = ((cy - r.top) / r.height) * 2 - 1;
      const ray = new THREE.Raycaster();
      ray.setFromCamera({ x: nx, y: ny }, this.camera);
      const t = -ray.ray.origin.y / ray.ray.direction.y;
      if (t > 0 && isFinite(t)) {
        const gx = ray.ray.origin.x + ray.ray.direction.x * t;
        const gz = ray.ray.origin.z + ray.ray.direction.z * t;
        const dx = gx - this.player.head.x, dz = gz - this.player.head.z;
        if (dx * dx + dz * dz > 1.2) {
          this.pointerAngle = Math.atan2(dz, dx);
          this.pointerT = performance.now();
        }
      }
    };
    cv.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') toAngle(e.clientX, e.clientY); });
    cv.addEventListener('pointerdown', (e) => { Sound.ensure(); toAngle(e.clientX, e.clientY); });
    cv.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (t) toAngle(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.togglePause(true);
    });
  },

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  },

  newGame() {
    for (const w of this.worms) w.dispose();
    this.worms = [];
    this.foods.items.slice().forEach((it) => this.foods.remove(it));
    this.foods.fill(FOOD_N);
    const name = ($('player-name').value || 'لاعب').slice(0, 14) || 'لاعب';
    try { localStorage.setItem(NAME_KEY, name); } catch { /* privado */ }
    this.player = new Worm(this.scene, { name, skin: this.skinIdx, speed: 7.2, turn: 3.6 });
    this.worms.push(this.player);
    const diff = DIFFS[this.diffKey];
    const botNames = ['سريع', 'مفترس', 'ظل', 'صحراوي', 'ليلي'];
    for (let i = 0; i < diff.bots; i++) {
      this.worms.push(new Worm(this.scene, {
        name: 'دودة ' + botNames[i % botNames.length],
        isBot: true, skin: (this.skinIdx + i + 1) % SKINS.length,
        speed: diff.botSpeed + Math.random(), turn: diff.botTurn,
      }));
    }
    this.state = 'playing';
    $('menu').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('pause-hint').classList.remove('hidden');
    Sound.ensure(); Sound.click();
  },

  togglePause(force) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    const toPause = force === true ? true : this.state === 'playing';
    this.state = toPause ? 'paused' : 'playing';
    $('paused').classList.toggle('hidden', !toPause);
  },

  toggleMute() {
    Sound.muted = !Sound.muted;
    $('mute-btn').textContent = Sound.muted ? '🔇' : '🔊';
  },

  killWorm(w, cause) {
    if (!w.alive) return;
    w.alive = false;
    Sound.ensure();
    const col = new THREE.Color(SKINS[w.skin % SKINS.length].base);
    this.bursts.spawn(w.head.x, 1, w.head.z, col, 26, 7);
    const drops = Math.min(16, 5 + (w.length >> 2));
    for (let i = 0; i < drops; i++) {
      const idx = Math.floor((i / drops) * w.length);
      const p = w.points[idx];
      if (p) this.foods.add(p.x + (Math.random() - 0.5) * 2, p.z + (Math.random() - 0.5) * 2, 0, 6);
    }
    w.dispose();
    if (w === this.player) {
      Sound.death();
      this.gameOver(cause);
    }
  },

  gameOver(cause) {
    this.state = 'over';
    const best = this.best();
    const isRecord = this.player.score > best;
    if (isRecord) { try { localStorage.setItem(BEST_KEY, String(this.player.score)); } catch { /* privado */ } }
    $('final-score').textContent = this.player.score;
    $('final-length').textContent = this.player.length;
    $('final-best').textContent = Math.max(best, this.player.score);
    $('death-cause').textContent = cause === 'wall' ? '🧱 اصطدمت بالجدار الحجري!'
      : cause === 'self' ? '🌀 عضضت نفسك!'
      : '💥 اصطدمت بدودة أكبر منك!';
    $('new-record').classList.toggle('hidden', !isRecord);
    $('hud').classList.add('hidden');
    $('gameover').classList.remove('hidden');
  },

  best() {
    try { return parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; }
    catch { return 0; }
  },

  botThink(w, dt) {
    w.wanderT -= dt;
    const r = Math.hypot(w.head.x, w.head.z);
    if (r > ARENA_R - 8) {
      w.targetAngle = Math.atan2(-w.head.z, -w.head.x) + Math.sin(this.clock * 2) * 0.4;
      return;
    }
    let bx = 0, bz = 0, threat = false;
    for (const o of this.worms) {
      if (o === w || !o.alive) continue;
      const dx = o.head.x - w.head.x, dz = o.head.z - w.head.z;
      const d = Math.hypot(dx, dz);
      if (d < 7 && o.length >= w.length) {
        bx -= dx / (d + 0.1); bz -= dz / (d + 0.1); threat = true;
      }
    }
    if (threat) {
      w.targetAngle = Math.atan2(bz, bx);
      w.boosting = r < ARENA_R - 14 && Math.random() < 0.5;
      return;
    }
    if (w.wanderT <= 0) {
      w.wanderT = 0.8 + Math.random() * 1.5;
      let bi = null, bd = 1e9;
      for (const f of this.foods.items) {
        const d = (f.x - w.head.x) ** 2 + (f.z - w.head.z) ** 2;
        if (d < bd) { bd = d; bi = f; }
      }
      if (bi && Math.random() < 0.85) {
        w.targetAngle = Math.atan2(bi.z - w.head.z, bi.x - w.head.x) + (Math.random() - 0.5) * 0.3;
      } else {
        w.targetAngle = w.angle + (Math.random() - 0.5) * 1.6;
      }
    }
    w.boosting = false;
  },

  playerThink(dt) {
    const p = this.player;
    const k = this.keys;
    if (k.KeyA || k.ArrowLeft) { p.targetAngle = p.angle - 2.6 * dt * 2; this.pointerAngle = null; }
    if (k.KeyD || k.ArrowRight) { p.targetAngle = p.angle + 2.6 * dt * 2; this.pointerAngle = null; }
    if (this.pointerAngle !== null && performance.now() - this.pointerT < 4000) {
      p.targetAngle = this.pointerAngle;
    }
    p.boosting = !!(k.Space || k.ShiftLeft || k.ShiftRight || k.KeyW || k.ArrowUp || this.touchBoost);
  },

  collide() {
    for (const w of this.worms) {
      if (!w.alive) continue;
      const hx = w.head.x, hz = w.head.z;
      if (Math.hypot(hx, hz) > ARENA_R - 0.5) { this.killWorm(w, 'wall'); continue; }
      // Corpo próprio (ignora os 6 primeiros: são o pescoço)
      for (let i = 6; i < w.points.length; i += 2) {
        const s = w.points[i];
        const rr = w.bodyR * 0.8;
        if ((s.x - hx) ** 2 + (s.z - hz) ** 2 < rr * rr) { this.killWorm(w, 'self'); break; }
      }
      if (!w.alive) continue;
      for (const o of this.worms) {
        if (o === w || !o.alive) continue;
        const step = o === this.player || w === this.player ? 1 : 3;
        for (let i = 2; i < o.points.length; i += step) {
          const s = o.points[i];
          const rr = o.bodyR * 0.85 + w.headR * 0.4;
          if ((s.x - hx) ** 2 + (s.z - hz) ** 2 < rr * rr) { this.killWorm(w, 'other'); break; }
        }
        if (!w.alive) break;
      }
    }
    // Comer
    for (const w of this.worms) {
      if (!w.alive) continue;
      for (let i = this.foods.items.length - 1; i >= 0; i--) {
        const f = this.foods.items[i];
        const rr = w.headR + 0.5;
        if ((f.x - w.head.x) ** 2 + (f.z - w.head.z) ** 2 < rr * rr) {
          w.score += f.value;
          w.syncMeshes();
          this.bursts.spawn(f.x, 0.8, f.z, f.kind === 1 ? 0xff5252 : f.kind === 2 ? 0xffd54f : 0x9fff9f, 8, 3);
          if (w === this.player) { Sound.ensure(); Sound.eat(f.kind > 0); }
          this.foods.remove(f);
        }
      }
    }
    // Repõe bots mortos para a arena continuar viva
    const diff = DIFFS[this.diffKey];
    const botsAlive = this.worms.filter((w) => w.isBot && w.alive).length;
    if (this.state === 'playing' && botsAlive < diff.bots && Math.random() < 0.02) {
      const names = ['سريع', 'مفترس', 'ظل', 'صحراوي', 'ليلي'];
      this.worms.push(new Worm(this.scene, {
        name: 'دودة ' + names[(Math.random() * names.length) | 0],
        isBot: true, skin: (Math.random() * SKINS.length) | 0,
        speed: diff.botSpeed, turn: diff.botTurn,
      }));
    }
    this.worms = this.worms.filter((w) => w.alive || w === this.player);
    if (this.foods.items.length < FOOD_N && Math.random() < 0.3) {
      const p = this.randArena(4);
      this.foods.add(p.x, p.z);
    }
  },

  updateCamera(dt) {
    const p = this.player;
    if (!p) return;
    const fx = Math.cos(p.angle), fz = Math.sin(p.angle);
    const tx = p.head.x - fx * 9, tz = p.head.z - fz * 9;
    const ty = 8;
    const k = Math.min(1, 4.5 * dt);
    this.camera.position.x = lerp(this.camera.position.x, tx, k);
    this.camera.position.y = lerp(this.camera.position.y, ty, k);
    this.camera.position.z = lerp(this.camera.position.z, tz, k);
    this.camera.lookAt(p.head.x + fx * 5, 1, p.head.z + fz * 5);
  },

  drawMinimap() {
    const g = this.minimap, S = 132, C = S / 2;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(10,25,10,0.72)';
    g.beginPath(); g.arc(C, C, C - 2, 0, TAU); g.fill();
    g.strokeStyle = '#7bff9e'; g.lineWidth = 2;
    g.beginPath(); g.arc(C, C, C - 2, 0, TAU); g.stroke();
    const sc = (C - 4) / ARENA_R;
    for (const f of this.foods.items) {
      g.fillStyle = f.kind === 1 ? '#ff5252' : f.kind === 2 ? '#ffd54f' : '#9fff9f';
      g.fillRect(C + f.x * sc - 1, C + f.z * sc - 1, 2, 2);
    }
    for (const w of this.worms) {
      if (!w.alive) continue;
      g.fillStyle = w === this.player ? '#ffffff' : '#ffab91';
      g.beginPath();
      g.arc(C + w.head.x * sc, C + w.head.z * sc, w === this.player ? 3.5 : 2.5, 0, TAU);
      g.fill();
    }
  },

  updateHud() {
    const p = this.player;
    if (!p) return;
    $('score').textContent = p.score;
    $('length').textContent = p.length;
    $('best').textContent = Math.max(this.best(), p.score);
    const rows = this.worms.filter((w) => w.alive)
      .sort((a, b) => b.score - a.score).slice(0, 6);
    $('board-rows').innerHTML = rows.map((w, i) =>
      `<div class="brow${w === p ? ' me' : ''}"><span>${i + 1}. ${w.name}</span><b>${w.score}</b></div>`).join('');
  },

  loop() {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, 1 / 60);
    this.clock += dt;
    const t = this.clock;
    if (this.state === 'playing') {
      this.playerThink(dt);
      for (const w of this.worms) {
        if (!w.alive) continue;
        if (w.isBot) this.botThink(w, dt);
        w.steer(dt);
        w.move(dt, (x, z, v) => this.foods.add(x, z, 0, v));
        w.render(t);
      }
      this.collide();
      this.updateCamera(dt);
      this.lbTimer -= dt;
      if (this.lbTimer <= 0) { this.lbTimer = 0.25; this.updateHud(); this.drawMinimap(); }
      $('boost-fill').style.width = (this.player.boosting ? 100 : 35) + '%';
    } else if (this.state === 'menu' || this.state === 'over') {
      const cx = Math.cos(t * 0.08) * 30, cz = Math.sin(t * 0.08) * 30;
      this.camera.position.set(cx, 26, cz);
      this.camera.lookAt(0, 0, 0);
      for (const w of this.worms) if (w.alive) w.render(t);
    } else if (this.state === 'paused') {
      for (const w of this.worms) if (w.alive) w.render(t);
    }
    this.foods.update(t);
    this.bursts.update(dt);
    this.renderer.render(this.scene, this.camera);
  },
};

function pick(list, sel, cb) {
  const els = [...list.children];
  els.forEach((el) => el.addEventListener('click', () => {
    Sound.ensure(); Sound.click();
    els.forEach((e) => e.classList.remove('sel'));
    el.classList.add('sel');
    cb(el.dataset.v);
  }));
  if (sel !== undefined && els[sel]) els[sel].classList.add('sel');
}

window.addEventListener('DOMContentLoaded', () => {
  Game.init();
  try {
    const n = localStorage.getItem(NAME_KEY);
    if (n) $('player-name').value = n;
    const b = localStorage.getItem(BEST_KEY);
    if (b) $('menu-best').textContent = b;
  } catch { /* storage bloqueado */ }
  pick($('skin-pick'), 0, (v) => { Game.skinIdx = parseInt(v, 10); });
  pick($('diff-pick'), 1, (v) => { Game.diffKey = v; });
  // WebGL pode falhar (navegador sem GPU): mensagem amigável em vez de tela preta
  $('start-btn').addEventListener('click', () => Game.newGame());
  $('again-btn').addEventListener('click', () => Game.newGame());
  $('resume-btn').addEventListener('click', () => Game.togglePause());
  $('restart-btn').addEventListener('click', () => { $('paused').classList.add('hidden'); Game.newGame(); });
  $('quit-btn').addEventListener('click', () => location.reload());
  $('mute-btn').addEventListener('click', () => { Sound.ensure(); Game.toggleMute(); });
  $('menu-mute').addEventListener('click', () => { Sound.ensure(); Game.toggleMute(); });
  window.__DODA = Game;
});

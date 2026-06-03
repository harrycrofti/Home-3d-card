/**
 * Home 3D Card — a Lovelace custom card that renders a 3D model of your home
 * (open-top / no ceiling) and overlays tappable "light sprites" bound to
 * Home Assistant light entities.
 *
 *  - View mode (the card on a dashboard):
 *      • each light entity glows when on; glow intensity tracks brightness
 *      • tap a light in the 3D view → light.toggle for that entity
 *
 *  - Edit mode (the card's visual config editor, opened via "Edit card"):
 *      • "Add light" then click on the model surface to drop a marker
 *      • assign which entity it controls, set colour + size
 *      • drag a marker to reposition; delete the selected one
 *      • "Save view" stores the current camera angle
 *      • all changes persist into the dashboard YAML (config-changed)
 *
 * Three.js is loaded on demand from a CDN (esm.sh) so there is no build step.
 * Set `three_cdn` in the config (or self-host) if your dashboards are viewed
 * offline. See README for the Sweet Home 3D → GLB export steps.
 */

const THREE_VERSION = "0.160.0";
const DEFAULT_CDN = "https://esm.sh";

// Cached module references once loaded (shared across all card instances).
let THREE = null;
let OrbitControls = null;
let GLTFLoader = null;
let MeshoptDecoder = null;
let _threeLoading = null;

async function loadThree(cdn) {
  if (THREE) return;
  if (_threeLoading) return _threeLoading;
  const base = (cdn || DEFAULT_CDN).replace(/\/+$/, "");
  _threeLoading = (async () => {
    THREE = await import(
      /* @vite-ignore */ `${base}/three@${THREE_VERSION}`
    );
    ({ OrbitControls } = await import(
      /* @vite-ignore */ `${base}/three@${THREE_VERSION}/examples/jsm/controls/OrbitControls.js`
    ));
    ({ GLTFLoader } = await import(
      /* @vite-ignore */ `${base}/three@${THREE_VERSION}/examples/jsm/loaders/GLTFLoader.js`
    ));
    // Decoder for meshopt-compressed geometry (EXT_meshopt_compression).
    // Loaded from the same CDN as three so we don't add another host.
    ({ MeshoptDecoder } = await import(
      /* @vite-ignore */ `${base}/three@${THREE_VERSION}/examples/jsm/libs/meshopt_decoder.module.js`
    ));
  })();
  return _threeLoading;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  model: undefined, // "/local/home.glb"
  three_cdn: DEFAULT_CDN,
  default_glow_color: "#ffd27f",
  default_size: 1, // marker size multiplier (×) of the model-relative base size
  ambient_intensity: 0.6, // base fill light (lower → room lighting reads more)
  background: "#0d1016",
  // Room lighting: each light marker also casts a real light into the model
  // when its entity is on, scaled by brightness.
  cast_light: true,
  light_intensity: 2, // brightness multiplier for the cast room light
  light_distance: 0.45, // light reach as a fraction of the model's size
  lights: [], // [{ entity, position:[x,y,z], color?, size? }]
  // Fans: spin a model object when the fan entity is on; speed ∝ percentage.
  fans: [], // [{ entity, object: <node name>, position:[x,y,z], reverse? }]
  fan_min_speed: 1.5, // rad/s at lowest non-zero percentage
  fan_max_speed: 11, // rad/s at 100%
  camera: undefined, // { position:[x,y,z], target:[x,y,z] }
};

/** Build a soft radial-gradient texture used for the glow sprites. */
function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(255,255,255,0.35)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------ *
 * Scene controller — shared by the card (view) and editor (edit).
 * ------------------------------------------------------------------ */

class Home3DScene {
  /**
   * @param {HTMLElement} container  element to render into (sized by CSS)
   * @param {object} opts            { interactive: boolean }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.interactive = !!opts.interactive; // edit mode = true
    this.sprites = []; // [{ entity, color, size, position:[x,y,z], object }]
    this.fans = []; // [{ entity, node, pivot, origParent, speed, target, reverse }]
    this._glowTex = null;
    this._raf = null;
    this._disposed = false;
    this._modelRoot = null;
    this._lastTime = 0;
    this._fanCfg = {};

    // callbacks wired by the host
    this.onTapSprite = null; // (spriteIndex) => void   (view mode)
    this.onTapFan = null; // (fanIndex) => void          (view mode)
    this.onPlace = null; // (point Vector3) => void       (edit: add light)
    this.onPlaceFan = null; // ({name, point}) => void    (edit: add fan)
    this.onSelect = null; // (spriteIndex|null) => void    (edit)
    this.onSelectFan = null; // (fanIndex) => void         (edit)
    this.onMove = null; // (spriteIndex, point) => void    (edit: drag)

    this._placing = false;
    this._placingFan = false;
    this._dragIndex = -1;
    this._selectedIndex = -1;
  }

  async init(cdn, background, cfg) {
    await loadThree(cdn);
    if (this._disposed) return;
    this._cfg = cfg || DEFAULTS;
    this._glowTex = makeGlowTexture();

    const w = this.container.clientWidth || 600;
    const h = this.container.clientHeight || 360;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background || DEFAULTS.background);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.05, 1000);
    this.camera.position.set(6, 6, 6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Lighting so the model is visible (the home's own ceiling is removed).
    const amb =
      this._cfg.ambient_intensity != null
        ? this._cfg.ambient_intensity
        : DEFAULTS.ambient_intensity;
    this.scene.add(new THREE.AmbientLight(0xffffff, amb));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(5, 10, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xaecbff, 0.35);
    fill.position.set(-6, 4, -4);
    this.scene.add(fill);

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    this._bindPointer();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.container);

    this._animate();
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadModel(url) {
    if (!url) return;
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      if (MeshoptDecoder) loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        url,
        (gltf) => {
          if (this._modelRoot) this.scene.remove(this._modelRoot);
          this._modelRoot = gltf.scene;
          this.scene.add(this._modelRoot);
          this._fitCameraToModel();
          resolve(gltf);
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  _fitCameraToModel() {
    if (!this._modelRoot) return;
    const box = new THREE.Box3().setFromObject(this._modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 5;
    this._modelMaxDim = maxDim;
    // Base marker size derived from the model so sprites are visible/tappable
    // regardless of the model's unit scale (SH3D exports in centimetres).
    this._baseSize = maxDim * 0.02;
    const dist = maxDim * 1.6;
    this.camera.position.set(
      center.x + dist,
      center.y + dist * 0.9,
      center.z + dist
    );
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  applyCamera(cam) {
    if (!cam || !cam.position) return;
    this.camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
    if (cam.target) this.controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
    this.controls.update();
  }

  getCamera() {
    const p = this.camera.position;
    const t = this.controls.target;
    return {
      position: [round(p.x), round(p.y), round(p.z)],
      target: [round(t.x), round(t.y), round(t.z)],
    };
  }

  /** Rebuild all sprite objects from a lights config array. */
  setSprites(lights, defaults) {
    // remove old markers + their cast lights
    for (const s of this.sprites) {
      this.scene.remove(s.object);
      if (s.light) this.scene.remove(s.light);
    }
    this.sprites = [];
    const base = this._baseSize || 1;
    const castLight = defaults.cast_light !== false;
    const maxDim = this._modelMaxDim || 100;
    const distance = maxDim * (defaults.light_distance ?? 0.45);
    const intensityMult = defaults.light_intensity ?? 2;
    (lights || []).forEach((l) => {
      const color = l.color || defaults.default_glow_color;
      // size is a multiplier of the model-relative base size (default 1).
      const size = Number(l.size) || defaults.default_size || 1;
      const mat = new THREE.SpriteMaterial({
        map: this._glowTex,
        color: new THREE.Color(color),
        transparent: true,
        depthWrite: false,
        depthTest: false, // always visible (not hidden behind walls/roof)
        blending: THREE.AdditiveBlending,
        opacity: 0.25,
      });
      const sprite = new THREE.Sprite(mat);
      const p = l.position || [0, 1, 0];
      sprite.position.set(p[0], p[1], p[2]);
      sprite.scale.setScalar(base * size);
      sprite.renderOrder = 999; // draw on top of the model
      sprite.userData.isLightSprite = true;
      this.scene.add(sprite);

      // Real light that illuminates the room when the entity is on. With
      // physical falloff (decay 2), peak intensity scales with distance².
      let light = null;
      let baseIntensity = 0;
      if (castLight) {
        light = new THREE.PointLight(new THREE.Color(color), 0, distance, 2);
        light.position.set(p[0], p[1], p[2]);
        this.scene.add(light);
        const ref = distance * 0.5;
        baseIntensity = ref * ref * intensityMult;
      }

      this.sprites.push({
        entity: l.entity,
        color,
        size,
        position: [p[0], p[1], p[2]],
        object: sprite,
        light,
        baseIntensity,
      });
    });
  }

  /** Update glow per entity state. `getState(entity)` => {on, brightness0to1}. */
  updateStates(getState) {
    const base = this._baseSize || 1;
    for (const s of this.sprites) {
      const st = s.entity ? getState(s.entity) : { on: false, brightness: 0 };
      const on = !!(st && st.on);
      const b = on ? clamp(st.brightness ?? 1, 0, 1) : 0;
      const mat = s.object.material;
      mat.opacity = on ? 0.45 + 0.55 * b : 0.25;
      const pulse = on ? 1 + 0.3 * b : 0.7;
      s.object.scale.setScalar(base * s.size * pulse);
      // Room lighting: intensity follows brightness, off = dark.
      if (s.light) s.light.intensity = on ? s.baseIntensity * (0.35 + 0.65 * b) : 0;
    }
  }

  highlight(index) {
    this._selectedIndex = index;
    this.sprites.forEach((s, i) => {
      s.object.material.color.set(i === index ? "#ffffff" : s.color);
    });
  }

  /* ---- fans ---- */

  /** Find a model object by its node name; fall back to smallest mesh at pos. */
  _findObject(name, pos) {
    if (!this._modelRoot) return null;
    let byName = null;
    if (name) {
      this._modelRoot.traverse((o) => {
        if (!byName && o.name === name) byName = o;
      });
      if (byName) return byName;
    }
    if (!pos) return null;
    const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const box = new THREE.Box3();
    let best = null;
    let bestVol = Infinity;
    this._modelRoot.traverse((o) => {
      if (!o.isMesh) return;
      box.setFromObject(o);
      if (!box.containsPoint(p)) return;
      const s = box.getSize(new THREE.Vector3());
      const vol = s.x * s.y * s.z;
      if (vol < bestVol) {
        bestVol = vol;
        best = o;
      }
    });
    return best;
  }

  /**
   * Collect all mesh parts that make up one fan, starting from a clicked seed
   * mesh. Many furniture models export as several meshes (housing, hub,
   * blades); we grow the group by bounding-box adjacency so the whole fan spins
   * together — while excluding structural geometry (walls/floors) and any mesh
   * too large to be a fan part. Returns an array of node names.
   */
  _collectFanParts(seed) {
    if (!seed || !this._modelRoot) return [];
    const STRUCT = /^(wall|ground|floor|slab|room|ceiling_\d)/i;
    const maxDim = this._modelMaxDim || 100;
    const partCap = maxDim * 0.3; // a fan part is small vs. the whole house
    const gap = maxDim * 0.01; // tolerate small gaps between parts
    const candidates = [];
    this._modelRoot.traverse((o) => {
      if (!o.isMesh || !o.name || STRUCT.test(o.name)) return;
      const b = new THREE.Box3().setFromObject(o);
      const s = b.getSize(new THREE.Vector3());
      if (Math.max(s.x, s.y, s.z) > partCap) return; // skip walls/ceilings/etc.
      candidates.push({ o, box: b });
    });
    const chosen = new Set([seed]);
    const groupBox = new THREE.Box3().setFromObject(seed);
    let added = true;
    let passes = 0;
    while (added && passes < 8) {
      added = false;
      passes++;
      const grown = groupBox.clone().expandByScalar(gap);
      for (const c of candidates) {
        if (chosen.has(c.o)) continue;
        if (grown.intersectsBox(c.box)) {
          chosen.add(c.o);
          groupBox.union(c.box);
          added = true;
        }
      }
    }
    return [...chosen].map((o) => o.name).filter(Boolean);
  }

  /** Resolve a fan's configured part names (or legacy single object). */
  _resolveFanNodes(cf) {
    const names =
      cf.objects && cf.objects.length
        ? cf.objects
        : cf.object
        ? [cf.object]
        : [];
    const nodes = [];
    names.forEach((n) => {
      const found = this._findObject(n, null);
      if (found) nodes.push(found);
    });
    if (!nodes.length) {
      const one = this._findObject(null, cf.position);
      if (one) nodes.push(one);
    }
    return nodes;
  }

  /**
   * Rebuild spinning fan rigs. All of a fan's parts are re-parented under one
   * pivot at the clicked point (X/Z) and spun around the world-up (Y) axis.
   */
  setFans(fans, cfg) {
    this._fanCfg = cfg || {};
    // tear down previous rigs — return nodes to their original parents first
    for (const f of this.fans) {
      (f.nodes || []).forEach((n, idx) =>
        (f.origParents[idx] || this._modelRoot).attach(n)
      );
      if (f.pivot) this.scene.remove(f.pivot);
      if (f.lightObj) this.scene.remove(f.lightObj);
    }
    this.fans = [];
    if (!this._modelRoot) return;
    const castLight = cfg.cast_light !== false;
    const maxDim = this._modelMaxDim || 100;
    const distance = maxDim * (cfg.light_distance ?? 0.45);
    const ref = distance * 0.5;
    const baseIntensity = ref * ref * (cfg.light_intensity ?? 2);
    (fans || []).forEach((cf) => {
      const nodes = this._resolveFanNodes(cf);
      let pivot = null;
      const origParents = [];
      if (nodes.length) {
        const groupBox = new THREE.Box3();
        nodes.forEach((n) => groupBox.expandByObject(n));
        const center = groupBox.getCenter(new THREE.Vector3());
        // Spin axis through the clicked point so an off-centre group doesn't
        // orbit/wobble. Click the hub when placing.
        const ax = cf.position ? cf.position[0] : center.x;
        const az = cf.position ? cf.position[2] : center.z;
        pivot = new THREE.Group();
        pivot.position.set(ax, center.y, az);
        this.scene.add(pivot);
        nodes.forEach((n) => {
          origParents.push(n.parent || this._modelRoot);
          pivot.attach(n); // keeps world transform; spins around world-Y
        });
      }
      // Optional integrated light (these fans have a light kit).
      let lightObj = null;
      if (castLight && cf.light) {
        const p = cf.position || [0, 0, 0];
        lightObj = new THREE.PointLight(new THREE.Color("#ffe0b0"), 0, distance, 2);
        lightObj.position.set(p[0], p[1], p[2]);
        this.scene.add(lightObj);
      }
      this.fans.push({
        entity: cf.entity,
        light: cf.light || "",
        nodes,
        pivot,
        origParents,
        lightObj,
        baseIntensity,
        speed: 0, // current angular velocity (rad/s)
        target: 0, // desired angular velocity
        reverse: !!cf.reverse,
      });
    });
  }

  /**
   * getFan(entity) => { on, percent:0..1 } sets spin; getLight(entity) =>
   * { on, brightness:0..1 } drives the integrated light.
   */
  updateFanStates(getFan, getLight) {
    const cfg = this._fanCfg || {};
    const min = cfg.fan_min_speed ?? 1.5;
    const max = cfg.fan_max_speed ?? 11;
    for (const f of this.fans) {
      const st = f.entity ? getFan(f.entity) : { on: false, percent: 0 };
      const on = !!(st && st.on);
      const pct = on ? clamp(st.percent ?? 1, 0, 1) : 0;
      let t = on ? min + (max - min) * pct : 0;
      if (f.reverse) t = -t;
      f.target = t;
      if (f.lightObj) {
        const ls = f.light && getLight ? getLight(f.light) : { on: false, brightness: 0 };
        const lon = !!(ls && ls.on);
        const b = lon ? clamp(ls.brightness ?? 1, 0, 1) : 0;
        f.lightObj.intensity = lon ? f.baseIntensity * (0.35 + 0.65 * b) : 0;
      }
    }
  }

  _fanIndexForObject(obj) {
    for (let i = 0; i < this.fans.length; i++) {
      const nodes = this.fans[i].nodes || [];
      let o = obj;
      while (o) {
        if (nodes.indexOf(o) >= 0) return i;
        o = o.parent;
      }
    }
    return -1;
  }

  /* ---- pointer / raycasting ---- */

  setPlacing(on) {
    this._placing = on;
    this.renderer.domElement.style.cursor = on ? "crosshair" : "";
  }

  setPlacingFan(on) {
    this._placingFan = on;
    this.renderer.domElement.style.cursor = on ? "crosshair" : "";
  }

  _ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this._pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  }

  _raycastSprites() {
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const objs = this.sprites.map((s) => s.object);
    const hits = this._raycaster.intersectObjects(objs, false);
    if (!hits.length) return -1;
    return objs.indexOf(hits[0].object);
  }

  /** First real mesh under the pointer (skips glow sprites). Scene-wide, so it
   *  also hits fan objects that have been re-parented under pivot groups. */
  _raycastModelHit() {
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObjects(this.scene.children, true);
    for (const h of hits) {
      const o = h.object;
      if (o.isSprite || (o.userData && o.userData.isLightSprite)) continue;
      if (o.isMesh) return { object: o, point: h.point.clone() };
    }
    return null;
  }

  _raycastModel() {
    const hit = this._raycastModelHit();
    return hit ? hit.point : null;
  }

  _bindPointer() {
    const el = this.renderer.domElement;

    el.addEventListener("pointerdown", (ev) => {
      this._ndc(ev);
      const spriteIdx = this._raycastSprites();

      if (!this.interactive) {
        // VIEW mode: tap a light → toggle; else maybe a fan → toggle
        if (spriteIdx >= 0 && this.onTapSprite) {
          this.onTapSprite(spriteIdx);
          return;
        }
        const hit = this._raycastModelHit();
        if (hit) {
          const fi = this._fanIndexForObject(hit.object);
          if (fi >= 0 && this.onTapFan) this.onTapFan(fi);
        }
        return;
      }

      // EDIT mode
      if (this._placingFan) {
        const hit = this._raycastModelHit();
        if (hit && this.onPlaceFan) {
          const names = this._collectFanParts(hit.object);
          this.onPlaceFan({
            seed: hit.object.name,
            names,
            point: hit.point,
          });
        }
        this.setPlacingFan(false);
        return;
      }
      if (this._placing) {
        const pt = this._raycastModel();
        if (pt && this.onPlace) this.onPlace(pt);
        this.setPlacing(false);
        return;
      }
      if (spriteIdx >= 0) {
        // Clicked a marker → select it (and start a potential drag).
        this._dragIndex = spriteIdx;
        this.controls.enabled = false;
        this.highlight(spriteIdx);
        if (this.onSelect) this.onSelect(spriteIdx);
      } else {
        // Clicked a model object that's a registered fan → select it.
        const hit = this._raycastModelHit();
        if (hit) {
          const fi = this._fanIndexForObject(hit.object);
          if (fi >= 0 && this.onSelectFan) this.onSelectFan(fi);
        }
      }
      // Otherwise selection is kept and OrbitControls rotates/pans the view.
    });

    el.addEventListener("pointermove", (ev) => {
      if (this._dragIndex < 0) return;
      this._ndc(ev);
      const pt = this._raycastModel();
      if (pt) {
        const s = this.sprites[this._dragIndex];
        s.object.position.copy(pt);
        s.position = [round(pt.x), round(pt.y), round(pt.z)];
        if (this.onMove) this.onMove(this._dragIndex, s.position);
      }
    });

    const endDrag = () => {
      if (this._dragIndex >= 0) {
        this._dragIndex = -1;
        this.controls.enabled = true;
      }
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointerleave", endDrag);
  }

  _animate() {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(() => this._animate());
    const now =
      typeof performance !== "undefined" ? performance.now() : this._lastTime + 16;
    let dt = (now - (this._lastTime || now)) / 1000;
    this._lastTime = now;
    if (dt > 0.1) dt = 0.1; // clamp after tab was backgrounded
    // Spin fans: ease current speed toward target, then advance rotation.
    for (const f of this.fans) {
      if (!f.pivot) continue;
      f.speed += (f.target - f.speed) * Math.min(1, dt * 3);
      if (Math.abs(f.speed) > 1e-4) f.pivot.rotation.y += f.speed * dt;
    }
    if (this.controls) this.controls.update();
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * The card (view mode)
 * ------------------------------------------------------------------ */

class Home3DCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._scene = null;
    this._ready = false;
    this._popupFan = null;
  }

  static getConfigElement() {
    return document.createElement("home-3d-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:home-3d-card",
      model: "/local/home.glb",
      lights: [],
      fans: [],
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const incoming = { ...DEFAULTS, ...config };
    if (!incoming.lights) incoming.lights = [];
    if (!incoming.fans) incoming.fans = [];
    const modelChanged =
      !this._scene || incoming.model !== (this._config && this._config.model);
    this._config = incoming;
    if (modelChanged) {
      this._build(); // first build, or model path changed → (re)load scene
    } else if (this._ready) {
      // Only lights/fans/appearance changed → refresh without reloading.
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.setFans(this._config.fans, this._config);
      this._applyStates();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._applyStates();
  }

  getCardSize() {
    return 8;
  }

  _stateFor(entity) {
    const st = this._hass && this._hass.states[entity];
    if (!st) return { on: false, brightness: 0 };
    const on = st.state === "on";
    const b = st.attributes && st.attributes.brightness;
    return { on, brightness: b != null ? b / 255 : 1 };
  }

  _fanStateFor(entity) {
    const st = this._hass && this._hass.states[entity];
    if (!st) return { on: false, percent: 0 };
    const on = st.state === "on";
    const pct = st.attributes && st.attributes.percentage;
    return { on, percent: pct != null ? pct / 100 : 1 };
  }

  _applyStates() {
    if (this._scene && this._ready) {
      this._scene.updateStates((e) => this._stateFor(e));
      this._scene.updateFanStates(
        (e) => this._fanStateFor(e),
        (e) => this._stateFor(e)
      );
    }
    if (this._popupFan != null) this._refreshFanPopup();
  }

  async _build() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { overflow:hidden; }
        .wrap { position:relative; width:100%; aspect-ratio: 16 / 10; }
        .stage { position:absolute; inset:0; }
        .msg {
          position:absolute; inset:0; display:flex; align-items:center;
          justify-content:center; text-align:center; padding:16px;
          color: var(--secondary-text-color,#9aa0a6); font-size:0.9rem;
        }
        .pop-back { position:absolute; inset:0; display:none; z-index:5; }
        .pop-back.show { display:block; }
        .popup {
          position:absolute; z-index:6; left:50%; bottom:12px;
          transform:translateX(-50%);
          background: rgba(20,24,32,0.96); color:#fff;
          border:1px solid rgba(255,255,255,0.14); border-radius:14px;
          padding:10px 12px; min-width:210px; display:none;
          box-shadow:0 8px 30px rgba(0,0,0,0.5); backdrop-filter:blur(8px);
        }
        .popup.show { display:block; }
        .popup .title { font-size:0.8rem; font-weight:700; margin-bottom:8px; opacity:0.9; }
        .popup .row { display:flex; gap:8px; align-items:center; margin-top:6px; }
        .popup button {
          flex:1; background: rgba(255,255,255,0.08); color:#fff; cursor:pointer;
          border:1px solid rgba(255,255,255,0.14); border-radius:9px;
          padding:9px 8px; font-size:0.85rem;
        }
        .popup button.on { background: var(--primary-color,#3b82f6); border-color:transparent; }
        .popup button.icon { flex:0 0 44px; font-size:1.1rem; }
        .popup .spd { flex:1; text-align:center; font-weight:700; font-size:0.9rem; }
        .popup .close { position:absolute; top:6px; right:8px; background:none;
          border:none; color:#aaa; font-size:1rem; padding:2px 6px; flex:none; }
      </style>
      <ha-card>
        <div class="wrap">
          <div class="stage" id="stage"></div>
          <div class="msg" id="msg">Loading 3D model…</div>
          <div class="pop-back" id="pop-back"></div>
          <div class="popup" id="popup"></div>
        </div>
      </ha-card>`;

    const stage = root.getElementById("stage");
    const msg = root.getElementById("msg");
    root.getElementById("pop-back").addEventListener("pointerdown", () =>
      this._hideFanPopup()
    );
    if (this._scene) this._scene.dispose();
    this._ready = false;
    this._popupFan = null;

    if (!this._config.model) {
      msg.textContent =
        "No model configured. Set `model: /local/your-home.glb` (see README for export steps).";
      return;
    }

    this._scene = new Home3DScene(stage, { interactive: false });
    this._scene.onTapSprite = (i) => {
      const s = this._scene.sprites[i];
      if (s && s.entity && this._hass) {
        this._hass.callService("light", "toggle", { entity_id: s.entity });
      }
    };
    this._scene.onTapFan = (i) => this._showFanPopup(i);

    try {
      await this._scene.init(
        this._config.three_cdn,
        this._config.background,
        this._config
      );
      await this._scene.loadModel(this._config.model);
      if (this._config.camera) this._scene.applyCamera(this._config.camera);
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.setFans(this._config.fans, this._config);
      this._ready = true;
      msg.style.display = "none";
      this._applyStates();
    } catch (err) {
      msg.textContent = `Failed to load 3D scene: ${err && err.message ? err.message : err}`;
      // eslint-disable-next-line no-console
      console.error("[home-3d-card]", err);
    }
  }

  /* ---- fan control popup ---- */

  _showFanPopup(i) {
    this._popupFan = i;
    const back = this.shadowRoot.getElementById("pop-back");
    const pop = this.shadowRoot.getElementById("popup");
    if (back) back.classList.add("show");
    if (pop) pop.classList.add("show");
    this._buildFanPopup(); // structure + listeners ONCE per open
    this._refreshFanPopup(); // fill in live state
  }

  _hideFanPopup() {
    this._popupFan = null;
    this._popEls = null;
    const back = this.shadowRoot.getElementById("pop-back");
    const pop = this.shadowRoot.getElementById("popup");
    if (back) back.classList.remove("show");
    if (pop) pop.classList.remove("show");
  }

  /** Build the popup DOM + attach listeners once (no rebuild on hass ticks). */
  _buildFanPopup() {
    const pop = this.shadowRoot.getElementById("popup");
    if (!pop || this._popupFan == null) return;
    const cf = this._config.fans[this._popupFan];
    if (!cf) {
      this._hideFanPopup();
      return;
    }
    let rows = "";
    if (cf.light)
      rows += `<div class="row"><button data-act="light" id="pf-light"></button></div>`;
    if (cf.entity)
      rows += `<div class="row"><button data-act="fan" id="pf-fan"></button></div>
        <div class="row">
          <button class="icon" data-act="down">－</button>
          <span class="spd" id="pf-spd"></span>
          <button class="icon" data-act="up">＋</button>
        </div>`;
    pop.innerHTML = `<button class="close" data-act="close">✕</button>
      <div class="title" id="pf-title">Fan</div>${rows}`;

    // Attach listeners once. Using a stored handler avoids duplicates.
    pop.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this._fanAction(b.dataset.act);
      })
    );
    this._popEls = {
      title: pop.querySelector("#pf-title"),
      light: pop.querySelector("#pf-light"),
      fan: pop.querySelector("#pf-fan"),
      spd: pop.querySelector("#pf-spd"),
    };
  }

  /** Update labels/state in place (cheap, runs on every hass tick). */
  _refreshFanPopup() {
    if (!this._popEls || this._popupFan == null) return;
    const cf = this._config.fans[this._popupFan];
    if (!cf) {
      this._hideFanPopup();
      return;
    }
    const fan = cf.entity ? this._stateRaw(cf.entity) : null;
    const light = cf.light ? this._stateRaw(cf.light) : null;
    const e = this._popEls;
    if (e.title) {
      e.title.textContent =
        (fan && fan.attributes && fan.attributes.friendly_name) ||
        (light && light.attributes && light.attributes.friendly_name) ||
        "Fan";
    }
    if (e.light) {
      const on = light && light.state === "on";
      e.light.textContent = `💡 Light ${on ? "On" : "Off"}`;
      e.light.classList.toggle("on", !!on);
    }
    if (e.fan) {
      const on = fan && fan.state === "on";
      e.fan.textContent = `🌀 Fan ${on ? "On" : "Off"}`;
      e.fan.classList.toggle("on", !!on);
    }
    if (e.spd) {
      const on = fan && fan.state === "on";
      const pct = fan && fan.attributes ? fan.attributes.percentage : null;
      e.spd.textContent = on ? (pct != null ? pct + "%" : "On") : "Off";
    }
  }

  _stateRaw(entity) {
    return this._hass && this._hass.states[entity];
  }

  _fanAction(act) {
    const cf = this._config.fans[this._popupFan];
    if (!cf || !this._hass) return;
    const h = this._hass;
    switch (act) {
      case "close":
        this._hideFanPopup();
        return;
      case "light":
        if (cf.light) h.callService("light", "toggle", { entity_id: cf.light });
        return;
      case "fan":
        if (cf.entity) h.callService("fan", "toggle", { entity_id: cf.entity });
        return;
      case "up":
        if (cf.entity) h.callService("fan", "increase_speed", { entity_id: cf.entity });
        return;
      case "down":
        if (cf.entity) h.callService("fan", "decrease_speed", { entity_id: cf.entity });
        return;
    }
  }

  disconnectedCallback() {
    if (this._scene) this._scene.dispose();
  }
}

customElements.define("home-3d-card", Home3DCard);

/* ------------------------------------------------------------------ *
 * The editor (edit mode — visual click-to-place)
 * ------------------------------------------------------------------ */

class Home3DCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._scene = null;
    this._ready = false;
    this._selected = -1;
    this._selectedFan = -1;
    this._built = false;
  }

  setConfig(config) {
    const incoming = { ...DEFAULTS, ...config };
    if (!incoming.lights) incoming.lights = [];
    if (!incoming.fans) incoming.fans = [];

    // HA echoes our own config-changed back by calling setConfig again. If it
    // matches what we already have, swallow it — otherwise every placed light
    // would tear down and reload the whole 3D scene.
    if (
      this._built &&
      this._config &&
      JSON.stringify(incoming) === JSON.stringify(this._config)
    ) {
      this._config = incoming;
      return;
    }

    const modelChanged =
      !this._built || incoming.model !== (this._config && this._config.model);
    this._config = incoming;

    if (!this._built || modelChanged) {
      this._build(); // first build, or model path changed → (re)load scene
    } else if (this._scene && this._ready) {
      // Only lights/fans/appearance changed externally → refresh in place.
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.setFans(this._config.fans, this._config);
      this._scene.updateStates((e) => this._stateFor(e));
      this._scene.updateFanStates(
        (e) => this._fanStateFor(e),
        (e) => this._stateFor(e)
      );
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._fillEntityPicker();
    this._fillFanPicker();
    if (this._scene && this._ready) {
      this._scene.updateStates((e) => this._stateFor(e));
      this._scene.updateFanStates(
        (e) => this._fanStateFor(e),
        (e) => this._stateFor(e)
      );
    }
  }

  _stateFor(entity) {
    const st = this._hass && this._hass.states[entity];
    if (!st) return { on: false, brightness: 0 };
    return {
      on: st.state === "on",
      brightness:
        st.attributes && st.attributes.brightness != null
          ? st.attributes.brightness / 255
          : 1,
    };
  }

  _fanStateFor(entity) {
    const st = this._hass && this._hass.states[entity];
    if (!st) return { on: false, percent: 0 };
    return {
      on: st.state === "on",
      percent:
        st.attributes && st.attributes.percentage != null
          ? st.attributes.percentage / 100
          : 1,
    };
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _lightEntities() {
    if (!this._hass) return [];
    return Object.keys(this._hass.states)
      .filter((e) => e.startsWith("light."))
      .sort();
  }

  _fillEntityPicker() {
    const sel = this.shadowRoot.getElementById("entity-pick");
    if (!sel || sel.childElementCount) return;
    sel.innerHTML =
      `<option value="">— pick a light entity —</option>` +
      this._lightEntities()
        .map((e) => `<option value="${e}">${e}</option>`)
        .join("");
  }

  _fanEntities() {
    if (!this._hass) return [];
    return Object.keys(this._hass.states)
      .filter((e) => e.startsWith("fan."))
      .sort();
  }

  _fillFanPicker() {
    const sel = this.shadowRoot.getElementById("fan-pick");
    if (sel && !sel.childElementCount) {
      sel.innerHTML =
        `<option value="">— pick a fan entity —</option>` +
        this._fanEntities()
          .map((e) => {
            const fn = (this._hass.states[e].attributes || {}).friendly_name || e;
            return `<option value="${e}">${fn}</option>`;
          })
          .join("");
    }
    const lsel = this.shadowRoot.getElementById("fan-light");
    if (lsel && !lsel.childElementCount) {
      lsel.innerHTML =
        `<option value="">— none —</option>` +
        this._lightEntities()
          .map((e) => `<option value="${e}">${e}</option>`)
          .join("");
    }
  }

  async _build() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host { display:block; color: var(--primary-text-color,#e1e1e1); }
        .modelrow { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
        .modelrow input { flex:1; }
        input, select, button {
          background: var(--secondary-background-color,#1c1f26);
          color: var(--primary-text-color,#e1e1e1);
          border:1px solid var(--divider-color,rgba(255,255,255,0.14));
          border-radius:6px; padding:7px 8px; font-size:0.85rem;
        }
        button { cursor:pointer; }
        button.primary { background: var(--primary-color,#3b82f6); color:#fff; border:none; }
        .stagewrap { position:relative; width:100%; height:360px; border-radius:8px; overflow:hidden; }
        .stage { position:absolute; inset:0; }
        .msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:16px; color: var(--secondary-text-color,#9aa0a6); }
        .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
        .hint { font-size:0.72rem; color: var(--secondary-text-color,#9aa0a6); margin:4px 0 10px; }
        .sel { margin-top:8px; padding:8px; border:1px solid var(--divider-color,rgba(255,255,255,0.14)); border-radius:8px; }
        .sel[hidden] { display:none; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:8px; align-items:center; }
        label.f { display:flex; flex-direction:column; gap:3px; font-size:0.8rem; }
        label.f > span { color: var(--secondary-text-color,#9aa0a6); }
      </style>

      <div class="modelrow">
        <label class="f" style="flex:1;">
          <span>Model path (/local/…glb)</span>
          <input type="text" id="model" placeholder="/local/home.glb" />
        </label>
      </div>

      <div class="stagewrap">
        <div class="stage" id="stage"></div>
        <div class="msg" id="msg">Loading 3D model…</div>
      </div>

      <div class="toolbar">
        <button id="add">➕ Add light</button>
        <button id="addfan">🌀 Add fan</button>
        <button id="savecam">📷 Save view</button>
        <span class="hint" id="placehint"></span>
      </div>
      <div class="hint"><b>Add light</b> → click a spot on the model. <b>Add fan</b> → click the fan object. Click a marker/fan to select it; drag a marker to reposition.</div>

      <div class="sel" id="sel" hidden>
        <div class="grid2">
          <label class="f">
            <span>Light entity</span>
            <select id="entity-pick"></select>
          </label>
          <label class="f">
            <span>Glow colour</span>
            <input type="color" id="color" value="#ffd27f" />
          </label>
          <label class="f">
            <span>Size (×)</span>
            <input type="range" id="size" min="0.2" max="5" step="0.1" />
          </label>
          <label class="f" style="justify-content:flex-end;">
            <span>&nbsp;</span>
            <button id="del">🗑 Delete light</button>
          </label>
        </div>
      </div>

      <div class="sel" id="fansel" hidden>
        <div class="grid2">
          <label class="f">
            <span>Fan entity</span>
            <select id="fan-pick"></select>
          </label>
          <label class="f">
            <span>Light entity (optional)</span>
            <select id="fan-light"></select>
          </label>
          <label class="f" style="flex-direction:row; align-items:center; gap:8px;">
            <input type="checkbox" id="fan-reverse" />
            <span>Reverse spin</span>
          </label>
          <label class="f" style="justify-content:flex-end;">
            <span>&nbsp;</span>
            <button id="fan-del">🗑 Remove fan</button>
          </label>
        </div>
        <div class="hint" id="fan-obj"></div>
      </div>
    `;
    this._built = true; // DOM exists; future setConfig echoes won't rebuild

    // model path field
    const modelInput = root.getElementById("model");
    modelInput.value = this._config.model || "";
    modelInput.addEventListener("change", () => {
      this._config.model = modelInput.value.trim() || undefined;
      this._emit();
      this._build(); // reload scene with new model
    });

    root.getElementById("add").addEventListener("click", () => {
      if (this._scene) {
        this._scene.setPlacing(true);
        root.getElementById("placehint").textContent =
          "Now click a spot on the model…";
      }
    });
    root.getElementById("addfan").addEventListener("click", () => {
      if (this._scene) {
        this._scene.setPlacingFan(true);
        root.getElementById("placehint").textContent =
          "Now click the fan object on the model…";
      }
    });
    root.getElementById("savecam").addEventListener("click", () => {
      if (this._scene) {
        this._config.camera = this._scene.getCamera();
        this._emit();
      }
    });

    this._wireSelectionPanel();
    this._wireFanPanel();
    this._fillEntityPicker();
    this._fillFanPicker();

    // build scene
    const stage = root.getElementById("stage");
    const msg = root.getElementById("msg");
    if (this._scene) this._scene.dispose();
    this._ready = false;

    if (!this._config.model) {
      msg.textContent = "Set a model path above to start placing lights.";
      return;
    }

    this._scene = new Home3DScene(stage, { interactive: true });
    this._scene.onPlace = (pt) => this._addLightAt(pt);
    this._scene.onPlaceFan = (hit) => this._addFanAt(hit);
    this._scene.onSelect = (i) => this._selectLight(i);
    this._scene.onSelectFan = (i) => this._selectFan(i);
    this._scene.onMove = (i, pos) => {
      this._config.lights[i].position = pos;
      this._emit();
    };

    try {
      await this._scene.init(
        this._config.three_cdn,
        this._config.background,
        this._config
      );
      await this._scene.loadModel(this._config.model);
      if (this._config.camera) this._scene.applyCamera(this._config.camera);
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.setFans(this._config.fans, this._config);
      this._ready = true;
      msg.style.display = "none";
      this._scene.updateStates((e) => this._stateFor(e));
      this._scene.updateFanStates(
        (e) => this._fanStateFor(e),
        (e) => this._stateFor(e)
      );
    } catch (err) {
      msg.textContent = `Failed to load 3D scene: ${err && err.message ? err.message : err}`;
      // eslint-disable-next-line no-console
      console.error("[home-3d-card-editor]", err);
    }
  }

  _addLightAt(pt) {
    const light = {
      entity: "",
      position: [round(pt.x), round(pt.y), round(pt.z)],
      color: this._config.default_glow_color,
      size: this._config.default_size,
    };
    this._config.lights.push(light);
    this._emit();
    this._scene.setSprites(this._config.lights, this._config);
    this._selectLight(this._config.lights.length - 1);
    this._scene.highlight(this._selected);
    this.shadowRoot.getElementById("placehint").textContent = "";
  }

  _selectLight(i) {
    this._selected = i == null ? -1 : i;
    this.shadowRoot.getElementById("fansel").hidden = true; // hide fan panel
    this._selectedFan = -1;
    const panel = this.shadowRoot.getElementById("sel");
    if (this._selected < 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const l = this._config.lights[this._selected];
    this.shadowRoot.getElementById("entity-pick").value = l.entity || "";
    this.shadowRoot.getElementById("color").value =
      l.color || this._config.default_glow_color;
    this.shadowRoot.getElementById("size").value =
      l.size || this._config.default_size;
  }

  _addFanAt(hit) {
    const fan = {
      entity: "",
      object: hit.seed || "",
      objects: hit.names && hit.names.length ? hit.names : undefined,
      position: [round(hit.point.x), round(hit.point.y), round(hit.point.z)],
    };
    this._config.fans.push(fan);
    this._emit();
    this._scene.setFans(this._config.fans, this._config);
    this._scene.updateFanStates(
        (e) => this._fanStateFor(e),
        (e) => this._stateFor(e)
      );
    this._selectFan(this._config.fans.length - 1);
    this.shadowRoot.getElementById("placehint").textContent = "";
  }

  _selectFan(i) {
    this._selectedFan = i == null ? -1 : i;
    this.shadowRoot.getElementById("sel").hidden = true; // hide light panel
    this._selected = -1;
    const panel = this.shadowRoot.getElementById("fansel");
    if (this._selectedFan < 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const f = this._config.fans[this._selectedFan];
    this.shadowRoot.getElementById("fan-pick").value = f.entity || "";
    this.shadowRoot.getElementById("fan-light").value = f.light || "";
    this.shadowRoot.getElementById("fan-reverse").checked = !!f.reverse;
    const parts = f.objects && f.objects.length ? f.objects.length : f.object ? 1 : 0;
    this.shadowRoot.getElementById("fan-obj").textContent = parts
      ? `${parts} part${parts > 1 ? "s" : ""} grouped (${f.object || "?"})`
      : "Object: (matched by position)";
  }

  _wireSelectionPanel() {
    const root = this.shadowRoot;
    root.getElementById("entity-pick").addEventListener("change", (e) => {
      if (this._selected < 0) return;
      this._config.lights[this._selected].entity = e.target.value;
      this._emit();
    });
    root.getElementById("color").addEventListener("change", (e) => {
      if (this._selected < 0) return;
      this._config.lights[this._selected].color = e.target.value;
      this._emit();
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.highlight(this._selected);
      this._scene.updateStates((en) => this._stateFor(en));
    });
    root.getElementById("size").addEventListener("input", (e) => {
      if (this._selected < 0) return;
      this._config.lights[this._selected].size = parseFloat(e.target.value);
      this._emit();
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.highlight(this._selected);
      this._scene.updateStates((en) => this._stateFor(en));
    });
    root.getElementById("del").addEventListener("click", () => {
      if (this._selected < 0) return;
      this._config.lights.splice(this._selected, 1);
      this._emit();
      this._scene.setSprites(this._config.lights, this._config);
      this._selectLight(null);
      this._scene.updateStates((en) => this._stateFor(en));
    });
  }

  _wireFanPanel() {
    const root = this.shadowRoot;
    const refresh = () => {
      this._scene.setFans(this._config.fans, this._config);
      this._scene.updateFanStates(
        (en) => this._fanStateFor(en),
        (en) => this._stateFor(en)
      );
    };
    root.getElementById("fan-pick").addEventListener("change", (e) => {
      if (this._selectedFan < 0) return;
      this._config.fans[this._selectedFan].entity = e.target.value;
      this._emit();
      this._scene.updateFanStates(
        (en) => this._fanStateFor(en),
        (en) => this._stateFor(en)
      );
    });
    root.getElementById("fan-light").addEventListener("change", (e) => {
      if (this._selectedFan < 0) return;
      this._config.fans[this._selectedFan].light = e.target.value;
      this._emit();
      refresh(); // light source is (re)created in setFans
    });
    root.getElementById("fan-reverse").addEventListener("change", (e) => {
      if (this._selectedFan < 0) return;
      this._config.fans[this._selectedFan].reverse = e.target.checked;
      this._emit();
      refresh();
    });
    root.getElementById("fan-del").addEventListener("click", () => {
      if (this._selectedFan < 0) return;
      this._config.fans.splice(this._selectedFan, 1);
      this._emit();
      this._selectFan(null);
      refresh();
    });
  }

  disconnectedCallback() {
    if (this._scene) this._scene.dispose();
  }
}

customElements.define("home-3d-card-editor", Home3DCardEditor);

/* ---- Lovelace card picker registration ---- */
window.customCards = window.customCards || [];
window.customCards.push({
  type: "home-3d-card",
  name: "Home 3D Card",
  description:
    "A 3D dollhouse view of your home with tappable glowing lights and spinning fans bound to HA entities.",
  preview: false,
  documentationURL: "https://github.com/harrycrofti/home-3d-card",
});

// eslint-disable-next-line no-console
console.info("%c HOME-3D-CARD %c loaded ", "background:#3b82f6;color:#fff", "");

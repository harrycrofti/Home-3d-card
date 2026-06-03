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
    this._glowTex = null;
    this._raf = null;
    this._disposed = false;
    this._modelRoot = null;

    // callbacks wired by the host
    this.onTapSprite = null; // (spriteIndex) => void   (view mode)
    this.onPlace = null; // (point Vector3) => void       (edit: add light)
    this.onSelect = null; // (spriteIndex|null) => void    (edit)
    this.onMove = null; // (spriteIndex, point) => void    (edit: drag)

    this._placing = false;
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

  /* ---- pointer / raycasting ---- */

  setPlacing(on) {
    this._placing = on;
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

  _raycastModel() {
    if (!this._modelRoot) return null;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObject(this._modelRoot, true);
    return hits.length ? hits[0].point.clone() : null;
  }

  _bindPointer() {
    const el = this.renderer.domElement;

    el.addEventListener("pointerdown", (ev) => {
      this._ndc(ev);
      const spriteIdx = this._raycastSprites();

      if (!this.interactive) {
        // VIEW mode: tap a light → toggle
        if (spriteIdx >= 0 && this.onTapSprite) this.onTapSprite(spriteIdx);
        return;
      }

      // EDIT mode
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
      }
      // Clicking empty space keeps the current selection (so the adjust panel
      // stays open) and lets OrbitControls rotate/pan the view.
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
  }

  static getConfigElement() {
    return document.createElement("home-3d-card-editor");
  }

  static getStubConfig() {
    return { type: "custom:home-3d-card", model: "/local/home.glb", lights: [] };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const incoming = { ...DEFAULTS, ...config };
    if (!incoming.lights) incoming.lights = [];
    const modelChanged =
      !this._scene || incoming.model !== (this._config && this._config.model);
    this._config = incoming;
    if (modelChanged) {
      this._build(); // first build, or model path changed → (re)load scene
    } else if (this._ready) {
      // Only lights/appearance changed → refresh markers without reloading.
      this._scene.setSprites(this._config.lights, this._config);
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

  _applyStates() {
    if (this._scene && this._ready) {
      this._scene.updateStates((e) => this._stateFor(e));
    }
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
      </style>
      <ha-card>
        <div class="wrap">
          <div class="stage" id="stage"></div>
          <div class="msg" id="msg">Loading 3D model…</div>
        </div>
      </ha-card>`;

    const stage = root.getElementById("stage");
    const msg = root.getElementById("msg");
    if (this._scene) this._scene.dispose();
    this._ready = false;

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

    try {
      await this._scene.init(
        this._config.three_cdn,
        this._config.background,
        this._config
      );
      await this._scene.loadModel(this._config.model);
      if (this._config.camera) this._scene.applyCamera(this._config.camera);
      this._scene.setSprites(this._config.lights, this._config);
      this._ready = true;
      msg.style.display = "none";
      this._applyStates();
    } catch (err) {
      msg.textContent = `Failed to load 3D scene: ${err && err.message ? err.message : err}`;
      // eslint-disable-next-line no-console
      console.error("[home-3d-card]", err);
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
    this._built = false;
  }

  setConfig(config) {
    const incoming = { ...DEFAULTS, ...config };
    if (!incoming.lights) incoming.lights = [];

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
      // Only lights/appearance changed externally → refresh markers in place.
      this._scene.setSprites(this._config.lights, this._config);
      this._scene.updateStates((e) => this._stateFor(e));
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._fillEntityPicker();
    if (this._scene && this._ready) {
      this._scene.updateStates((e) => this._stateFor(e));
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
        <button id="savecam">📷 Save view</button>
        <span class="hint" id="placehint"></span>
      </div>
      <div class="hint">Click <b>Add light</b>, then click on the model to drop a marker. Click a marker to select it; drag to reposition.</div>

      <div class="sel" id="sel" hidden>
        <div class="grid2">
          <label class="f">
            <span>Entity</span>
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
    root.getElementById("savecam").addEventListener("click", () => {
      if (this._scene) {
        this._config.camera = this._scene.getCamera();
        this._emit();
      }
    });

    this._wireSelectionPanel();
    this._fillEntityPicker();

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
    this._scene.onSelect = (i) => this._selectLight(i);
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
      this._ready = true;
      msg.style.display = "none";
      this._scene.updateStates((e) => this._stateFor(e));
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
    "A 3D dollhouse view of your home with tappable, glowing light entities.",
  preview: false,
  documentationURL: "https://github.com/harrycrofti/home-3d-card",
});

// eslint-disable-next-line no-console
console.info("%c HOME-3D-CARD %c loaded ", "background:#3b82f6;color:#fff", "");

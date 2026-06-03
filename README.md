# Home 3D Card info

A Lovelace **custom card** that renders a 3D model of your home (open-top /
no ceiling — a "dollhouse" view) and overlays **tappable, glowing light
markers** bound to your Home Assistant `light.*` entities.

- 💡 Each light **glows when on**; glow intensity tracks the bulb's brightness.
- 👆 **Tap a light** in the 3D view → it toggles (`light.toggle`).
- 🎯 A **visual click-to-place editor**: drop markers onto the model, assign the
  entity, set colour/size, drag to reposition — all saved into your dashboard.

Built on [three.js](https://threejs.org/), loaded on demand from a CDN, so there
is **no build step** — the card is a single file in `dist/`.

> ⚠️ Status: **v0.1 scaffold.** Functional end-to-end (load model, place lights,
> glow, tap-to-toggle) but expect rough edges. See [Roadmap](#roadmap).

---

## 1. Get your home into a web model (Sweet Home 3D → GLB)

The card needs a **`.glb`** (binary glTF) file. Your `.sh3d` can't be loaded
directly — export it like this:

### a) Author it open-top in Sweet Home 3D

To see the insides, the rooms must have **no ceiling** and no roof:

1. Open your plan in Sweet Home 3D.
2. Select all rooms (Edit → Select All, or drag a box in the plan).
3. Double-click a room → in the dialog, **untick "Ceiling visible"** → OK.
   (Apply to each room, or select multiple rooms first.)
4. If you added a **roof** as furniture, hide/delete it for the export.

### b) Export to OBJ

1. Click into the **3D view** so it's active.
2. Menu **3D View → "Export to OBJ format…"**.
3. Save as e.g. `home.obj`. Sweet Home 3D writes `home.obj`, `home.mtl`, and a
   folder of textures (often zipped — unzip it so the files sit together).

### c) Convert OBJ → GLB

Easiest is [`obj2gltf`](https://github.com/CesiumGS/obj2gltf) (needs Node.js):

```bash
npx obj2gltf -i home.obj -o home.glb
```

Alternative — **Blender**: `File → Import → Wavefront (.obj)`, then
`File → Export → glTF 2.0 (.glb)` (embed textures / format = "glTF Binary").

> Tip: keep the file small. A whole-house GLB should ideally be a few MB. If it's
> huge, decimate meshes in Blender or skip high-poly furniture.

### d) Put it where HA can serve it

Copy `home.glb` into your Home Assistant **`config/www/`** folder. It's then
served at **`/local/home.glb`**.

---

## 2. Install the card

1. Copy `dist/home-3d-card.js` into `config/www/` (e.g.
   `config/www/home-3d-card.js`).
2. **Settings → Dashboards → ⋮ → Resources → Add resource**
   - URL: `/local/home-3d-card.js`
   - Type: **JavaScript module**
3. Hard-refresh your browser (Ctrl/Cmd-Shift-R).

### Install via HACS (custom repository)

1. **HACS → ⋮ (top-right) → Custom repositories.**
2. Repository: `https://github.com/harrycrofti/home-3d-card` — Category: **Dashboard**.
3. **Add**, then find "Home 3D Card" in HACS and **Download** it.
4. HACS serves it at `/hacsfiles/home-3d-card/home-3d-card.js` and auto-registers
   the dashboard resource. Hard-refresh the browser.

---

## 3. Add it to a dashboard

Edit a dashboard → **Add card → search "Home 3D Card"**. Set the **model path**,
then use **Add light** to place your lights visually. Or write YAML directly:

```yaml
type: custom:home-3d-card
model: /local/home.glb
default_glow_color: "#ffd27f"
default_size: 1            # marker size multiplier (1 = auto, scaled to the model)
lights:
  - entity: light.kitchen
    position: [120, 240, -80]      # x, y, z in the model's own units (cm from SH3D)
  - entity: light.living_room
    position: [-210, 240, 150]
    color: "#aee1ff"
    size: 1.5               # 1.5× the default marker size
camera:
  position: [6, 6, 6]
  target: [0, 1, 0]
```

### Placing lights visually

1. Edit the card (pencil icon). The editor shows a full 3D preview.
2. Click **➕ Add light**, then click the spot on the model.
3. In the panel that appears, pick the **entity**, tweak **colour** and **size**.
4. **Drag** a marker to move it. Click a marker to re-select it.
5. **📷 Save view** stores the current camera angle as the default.
6. Everything is written back to the card's YAML automatically.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | path | _(none)_ | `/local/…glb` model of your home. **Required.** |
| `lights` | list | `[]` | Light markers: each `{ entity, position:[x,y,z], color?, size? }`. |
| `default_glow_color` | colour | `#ffd27f` | Glow colour for lights without their own `color`. |
| `default_size` | number | `1` | Marker size multiplier for lights without their own `size`. `1` = auto-sized to the model; the per-light `size` scales relative to that. |
| `camera` | map | _(auto-fit)_ | `{ position:[x,y,z], target:[x,y,z] }` starting view. |
| `background` | colour | `#0d1016` | Scene background colour. |
| `ambient_intensity` | number | `0.9` | Ambient light level for the model. |
| `three_cdn` | url | `https://esm.sh` | Where to load three.js from. Change to self-host for offline dashboards. |

---

## Offline / self-hosting three.js

By default three.js is fetched from `https://esm.sh`. If your dashboards are
viewed without internet, host three.js yourself and point `three_cdn` at it, or
(future) use a fully bundled build. Until then the device viewing the dashboard
needs internet access on first load.

---

## Roadmap

- [ ] Optional bundled three.js build (no CDN needed)
- [ ] Colour-from-bulb glow (match RGB), not just brightness
- [ ] Per-light icon/label tooltips on hover
- [ ] Support non-light domains (switches, covers) with custom tap actions
- [ ] Click-through occlusion (don't toggle a light hidden behind a wall)

## License

MIT

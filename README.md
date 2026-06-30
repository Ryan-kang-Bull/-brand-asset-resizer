# Brand Asset Resizer

A Figma plugin that lets the **product team** pull **brand-team artwork** from a
shared component library and drop it onto the canvas at any size — the
background fills the frame while the artwork keeps its real size. The **brand
team** can import illustrations and publish them to the library. It only ever
uses existing brand-approved components; it never generates new artwork.

---

## What it does

### 1. Pick artwork from the shared library
The grid shows a searchable, thumbnailed list of the assets published to the
shared Figma Team Library. Every user sees the **same** set no matter which file
they're in — assets resolve from the library by published `key`. See
[Shared asset library](#shared-asset-library) below.

(Variants of a component set are collapsed into the set so they don't show as
duplicates.)

### 2. Resize options appear under the selection
Click an artwork and an options panel activates beneath the grid:

- **Size** — responsive breakpoint presets, *Original*, or *Custom*
- **Width / Height** — Height left blank keeps the artwork's native height
- **Anchor** — Left / Center / Right: where the artwork sits horizontally once
  the background fills the frame (vertically it stays centered)

Every control has a **"?" info popover** explaining what it does.

### 3. Place or Export
- **Place on canvas** — instances the component, **detaches it to an editable
  frame**, and applies the resize.
- **Export** — does the same and downloads the result as **PNG / SVG / JPG**.

Detaching is intentional: it makes the inner layers (background / artwork / text)
editable. The placed/exported result is a flattened frame with no link back to
the master component.

---

## Breakpoint presets

Each preset sets the **width** to the midpoint of the breakpoint range; height
stays native unless you set it.

| Preset | Range | Width |
|--------|-------|-------|
| SM     | 320–767     | 544  |
| MD     | 768–1023    | 896  |
| LG     | 1024–1279   | 1152 |
| XL     | 1280–1439   | 1360 |
| 2XL    | 1440–1727   | 1584 |
| 3XL    | 1728+       | 1728 |

Plus **Original size** (native dimensions) and **Custom…** (type both).

---

## Resize behavior

Only the **background fills** the frame; the **artwork keeps its real size** and
is just repositioned. When an asset is placed/exported, the detached frame's
layers are classified by **type + z-order** and handled per role:

| Layer | Behavior |
|-------|----------|
| **Background** | Fills the frame edge-to-edge. The background is the bottommost `RECTANGLE`; if there isn't one, the frame's own fill backs the artwork; if there's neither, the **lowest layer is stretched** so the background is never left transparent. Image fills are forced to `FILL` (cover) so they fill without distortion. |
| **Artwork** | **Not scaled** — keeps its real dimensions. It shifts only to stay anchored as the frame grows: horizontally per **Anchor** (Left / Center / Right), vertically centered. |
| **Text** | Left untouched. |

Because the artwork isn't scaled, placing at **Original size** is an exact
identity — the result matches the thumbnail. Overflow past the frame is clipped.

---

## Importing artwork (brand team)

The **↑ Import** button has two modes:

- **With frames selected on the canvas** → converts each selected frame/group
  into a component (in place), ready to publish to the library.
- **With nothing selected** → opens a file picker to upload **SVG / PNG / JPG**;
  each becomes a component on the page.

The catalog refreshes automatically after an import.

---

## Shared asset library

So that **everyone running the plugin sees the same assets from any file**, the
shared catalog references components by their **Figma Team Library `key`** and
resolves them with `importComponentByKeyAsync` — which goes through Figma's own
infrastructure, so the plugin needs **no network access** (`networkAccess` stays
`none`).

Because Figma has no API to *enumerate* a library's contents, the catalog of
keys ships with the plugin as **`catalog.json`** and is baked into `build/code.js`
at build time. Updating the shared set is a publish-and-rebuild cycle:

> **Current contents:** the catalog is populated from the published
> **🍱 CD Visual Library – Grab and Go** team library — **67 assets** (14
> background graphics, 31 dark illustrations, 11 light illustrations, 11
> textures). Regenerate it with the **⤓ Catalog** workflow below whenever that
> library changes.

### Brand-team workflow

1. In the **Brand Assets source file**, add components with **↑ Import** (or
   normally), then **publish them to the Team Library** (Assets panel → publish).
   Only *published* components have a `key`.
2. Run the plugin in that file and click **⤓ Catalog**. It scans every published
   component, captures a thumbnail, and downloads a fresh **`catalog.json`**
   (and reports any unpublished components it skipped).
3. Replace `catalog.json` in this repo with the downloaded file, run
   `npm run build`, and **republish the plugin** so all users get the new set.

### Product-team setup

Enable the **🍱 CD Visual Library – Grab and Go** library for your file (Assets
panel → Libraries), then open the plugin — the published assets appear in the
grid, ready to place/export.

---

## Architecture

```
brand-asset-resizer/
├── manifest.json      # Figma plugin manifest (networkAccess: none)
├── catalog.json       # shared library manifest (component keys + thumbnails)
├── package.json       # build / watch / typecheck scripts
├── tsconfig.json      # TS target ES2017 (Figma's plugin VM requirement)
├── README.md
├── scripts/
│   └── inject-catalog.js  # bakes catalog.json into build/code.js after tsc
├── src/
│   ├── code.ts        # main thread — catalog, thumbnail, place/export, resize, import
│   └── ui.html        # picker UI + options panel + "?" popovers
└── build/             # compiled output (code.js + ui.html); manifest points here
```

- **`src/code.ts`** runs in Figma's sandbox (has the `figma` API). It serves the
  shared library catalog, and on request imports the asset by key, then
  instances + detaches + resizes it (fill background / keep artwork) — or
  imports/exports.
- **`catalog.json` → `build/code.js`**: there's no runtime module loader in
  Figma, so the manifest can't be a real `import`. `code.ts` holds a sentinel
  array literal that `scripts/inject-catalog.js` replaces with `catalog.json`'s
  contents after `tsc` runs (wired into `npm run build`).
- **`src/ui.html`** is the iframe UI. It talks to the main thread via
  `postMessage`. Tiles are built with `createElement` (not HTML strings) so
  special characters in asset names can't break the markup.

### Notes / gotchas
- **TypeScript target is ES2017.** Figma's plugin VM rejects ES2019 optional
  catch binding (`catch {}`); a newer target would emit it and crash on load.
- **Thumbnails** use plain `exportAsync` — it renders each component exactly as
  it appears on canvas.
- **Background detection** prefers the bottommost `RECTANGLE`, then the frame's
  own fill, then the lowest layer (stretched) as a last resort — so the
  background always fills and is never left transparent.

---

## Develop

```bash
npm install
npm run build      # compiles src/code.ts -> build/code.js and copies ui.html
npm run watch      # rebuild on change
npm run typecheck  # type-check without emitting
```

## Add the plugin in Figma (import from manifest)

Use this to run the plugin yourself from a local clone — for development, or to
try it before it's published to the org. Importing a manifest requires the
**Figma desktop app** (the browser can't read local files).

**Prerequisites**

1. Install the [Figma desktop app](https://www.figma.com/downloads/).
2. Install [Node.js](https://nodejs.org/) (v18+).
3. Clone this repo and build it once, so `build/code.js` and `build/ui.html`
   exist (the manifest points at `build/`):

   ```bash
   git clone git@github.com:Ryan-kang-Bull/-brand-asset-resizer.git
   cd -brand-asset-resizer
   npm install
   npm run build
   ```

**Import the manifest**

1. Open the **Figma desktop app**.
2. From the menu bar: **Plugins → Development → Import plugin from manifest…**
   (you can also right-click the canvas → **Plugins → Development → Import plugin
   from manifest…**).
3. Select the **`manifest.json`** at the root of this folder.
4. Figma adds **Brand Asset Resizer** under **Plugins → Development**.

**Run it**

- Open any file and choose **Plugins → Development → Brand Asset Resizer**. The
  shared library assets appear in the grid — pick one, set a size, and **Place on
  canvas** or **Export**.

**Notes**

- After editing source, run `npm run build` (or `npm run watch`) and **re-run**
  the plugin to pick up the new `build/`. No need to re-import the manifest.
- To get the latest assets/code, `git pull` then `npm run build`.
- If you **move or rename** this folder, Figma keeps pointing at the old path —
  remove the plugin from **Plugins → Development** and re-import the manifest
  from the new location.

## Distribute to the team

A *Development* install only exists on the machine that imported it, and reads
this folder's `build/` directly — product designers can't use it that way. To
ship it to everyone:

1. **Publish org-private:** Figma → **Plugins → Development → Brand Asset
   Resizer → Publish…** → choose **"Only for [your org]"** (not the public
   community). Designers then find it under **Plugins** and install once.
2. **Updating assets later:** regenerate `catalog.json` (⤓ Catalog), `npm run
   build`, then **republish the plugin** — installed users get the new version
   automatically. (Per-user *Development* installs would instead each need to
   re-pull this repo, which is why org-publishing is preferred.)

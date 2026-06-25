# Brand Asset Resizer

A Figma plugin that lets the **product team** pull **brand-team artwork** from a
component library and drop it onto the canvas resized for any responsive
breakpoint — with context-aware, per-layer resize behavior. The **brand team**
can import illustrations into the library. It only ever uses existing
brand-approved components; it never generates new artwork.

---

## What it does

### 1. Pick artwork from the shared library
The grid shows a searchable, thumbnailed list of assets from two sources:

- **Library** (badge) — the **shared** catalog every user sees, no matter which
  file they're in. These resolve from the Figma Team Library by published `key`,
  so the same set is available to everyone. See
  [Shared asset library](#shared-asset-library) below.
- **Local** (badge) — `COMPONENT` / `COMPONENT_SET` nodes in the *open* file
  that aren't published yet. Useful for brand-team WIP, and a graceful fallback
  when the shared catalog is empty.

(Variants of a component set are collapsed into the set so they don't show as
duplicates. A component published to the library won't also appear as Local.)

### 2. Resize options appear under the selection
Click an artwork and an options panel activates beneath the grid:

- **Size** — responsive breakpoint presets, *Original*, or *Custom*
- **Width / Height** — Height left blank keeps the artwork's native height
- **Threshold** — the width at which the resize mode switches (default 768)
- **Anchor** — Left / Center / Right (used in reposition mode)
- **Margin** — gap from the frame edge

Every control has a **"?" info popover** explaining what it does.

### 3. Place or Export
- **Place on canvas** — instances the component, **detaches it to an editable
  frame**, and applies the context-aware resize.
- **Export** — does the same and downloads the result as **PNG / SVG / JPG**.

Detaching is intentional: it makes the inner layers (background / artwork / text)
editable so they can be resized independently. The placed/exported result is a
flattened frame with no link back to the master component.

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

## Context-aware resize behavior

When an artwork is placed/exported, the detached frame's layers are classified
by **type + z-order**:

- **Background** — the bottommost `RECTANGLE`
- **Text** — any `TEXT` layer (left untouched)
- **Artwork** — everything else, treated as one bounding box

…and resized per role:

| Layer | Behavior |
|-------|----------|
| **Background** | Always scales to fill 100% of the frame. Gradients are stored normalized to the layer in Figma, so stops stay proportional rather than compressing. |
| **Artwork** | **Width ≥ threshold → Reposition mode:** keeps its exact dimensions and moves to the chosen anchor (+ margin), vertically centered. **Width < threshold → Scale mode:** scales to fit the limiting dimension, ratio locked (via `rescale`, so strokes/radii scale too), then centered. |
| **Text** | Untouched. |

---

## Importing artwork (brand team)

The **↑ Import** button has two modes:

- **With frames selected on the canvas** → converts each selected frame/group
  into a component (in place), so it joins the library.
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

Enable the **Brand Assets** library for your file (Assets panel → Libraries).
Library assets then place/export exactly like local ones.

> **Distribution note:** for "republish once, everyone updates," the plugin
> should be published to your Figma **org's private plugins**. With per-user
> *Development* installs, each user must re-pull this repo to get catalog
> updates.

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

- **`src/code.ts`** runs in Figma's sandbox (has the `figma` API). It merges the
  shared library catalog with local components, renders thumbnails, and on
  request resolves the asset (library import by key, or local node) then
  instances + detaches + resizes it — or imports/exports.
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
- **Layer detection** assumes the background is a bottommost `RECTANGLE`. A
  component that's just vectors with no background rectangle is treated entirely
  as artwork (it simply repositions/scales; there's no fill step).

---

## Develop

```bash
npm install
npm run build      # compiles src/code.ts -> build/code.js and copies ui.html
npm run watch      # rebuild on change
npm run typecheck  # type-check without emitting
```

## Load in Figma

1. Figma desktop → **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this folder.
3. Open a file containing the brand component library and run
   **Plugins → Development → Brand Asset Resizer**.

> If you move this folder, Figma keeps pointing at the old path — remove and
> re-import the manifest from the new location.

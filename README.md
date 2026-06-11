# Brand Asset Resizer

A Figma plugin that lets the **product team** pull **brand-team artwork** from a
component library and drop it onto the canvas resized for any responsive
breakpoint — with context-aware, per-layer resize behavior. The **brand team**
can import illustrations into the library. It only ever uses existing
brand-approved components; it never generates new artwork.

---

## What it does

### 1. Pick artwork from the library
The plugin scans the open file for all `COMPONENT` / `COMPONENT_SET` nodes and
shows them as a searchable, thumbnailed grid. (Variants of a component set are
collapsed into the set so they don't show as duplicates.)

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

## Architecture

```
brand-asset-resizer/
├── manifest.json      # Figma plugin manifest (networkAccess: none)
├── package.json       # build / watch / typecheck scripts
├── tsconfig.json      # TS target ES2017 (Figma's plugin VM requirement)
├── README.md
├── src/
│   ├── code.ts        # main thread — scan, thumbnail, place/export, resize, import
│   └── ui.html        # picker UI + options panel + "?" popovers
└── build/             # compiled output (code.js + ui.html); manifest points here
```

- **`src/code.ts`** runs in Figma's sandbox (has the `figma` API). It scans for
  components, renders thumbnails, and on request instances + detaches + resizes
  the chosen artwork, or imports new components.
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

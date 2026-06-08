# Brand Asset Resizer

A Figma plugin that lets the **product team** drop **brand-team assets** onto the
canvas, resized to standard product presets or a custom size. It only ever
instances *existing* brand-approved components — it never generates new artwork.

## How it works

- The **main thread** (`src/code.ts`) runs in Figma's sandbox. It scans the open
  file for `COMPONENT` / `COMPONENT_SET` nodes (the brand library), renders
  thumbnails, and on request clones the chosen component as an instance, resizes
  it, and places it at the center of the viewport.
- The **UI** (`src/ui.html`) is the picker: searchable thumbnail grid, a size
  preset dropdown (App icon, Avatar, Favicon, Social/OG, …), custom W×H inputs,
  and a "lock aspect ratio" toggle.

The brand team maintains the source of truth as a Figma file/library full of
components; the plugin reads from whatever file is currently open.

## Develop

```bash
npm install
npm run build     # compiles src/code.ts -> build/code.js and copies ui.html
npm run watch     # rebuild code on change
```

## Load in Figma

1. Figma desktop → **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this folder.
3. Open the file containing the brand component library and run
   **Plugins → Development → Brand Asset Resizer**.

> Note: `manifest.json` sets `networkAccess` to `none` because all assets come
> from components already in the file. If you later switch the brand source to a
> remote CDN/Drive, update `allowedDomains` accordingly.

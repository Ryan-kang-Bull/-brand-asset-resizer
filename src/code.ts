// Brand Asset Resizer — main thread (runs in Figma's sandbox; has the `figma` API).
//
// The product team picks a brand component in the Library, sets a target size and
// resize options, and the plugin places it on canvas — detached to an editable
// frame — applying context-aware, per-layer resize:
//   - background (bottommost rectangle) scales to fill the frame
//   - artwork repositions (wide frames) or scales-to-fit, ratio locked (narrow frames)
//   - text is left alone
// The brand team can import illustrations (canvas frames or uploaded files) as components.

const THUMB_MAX_PX = 240;

type ExportFormat = "PNG" | "SVG" | "JPG";

/** A place/export request: which asset, target size, and resize options. */
interface PlaceRequest {
  assetId: string;
  width: number;
  height: number | null; // null → keep the artwork's native height
  threshold: number; // width at/above which we reposition instead of scale
  anchorH: "left" | "center" | "right";
  margin: number;
}

interface ImportFile {
  name: string;
  format: ExportFormat;
  svg?: string;
  bytes?: Uint8Array;
}

type UIMessage =
  | { type: "init" }
  | ({ type: "place" } & PlaceRequest)
  | ({ type: "export"; format: ExportFormat } & PlaceRequest)
  | { type: "import-selection" }
  | { type: "import-files"; files: ImportFile[] };

figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if (msg.type === "init") {
      await sendCatalog();
    } else if (msg.type === "place") {
      await placeAsset(msg);
    } else if (msg.type === "export") {
      await exportAsset(msg);
    } else if (msg.type === "import-selection") {
      await importSelection();
    } else if (msg.type === "import-files") {
      await importFiles(msg.files);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Brand Asset Resizer]", err);
    figma.ui.postMessage({ type: "error", message });
    figma.notify(message, { error: true });
  }
};

// --- Catalog ---------------------------------------------------------------

async function sendCatalog(): Promise<void> {
  if (typeof figma.loadAllPagesAsync === "function") {
    await figma.loadAllPagesAsync();
  }

  const found = figma.root.findAllWithCriteria({
    types: ["COMPONENT", "COMPONENT_SET"],
  });
  const setIds = new Set(
    found.filter((n) => n.type === "COMPONENT_SET").map((n) => n.id)
  );
  const assets = found.filter(
    (n) => !(n.type === "COMPONENT" && n.parent && setIds.has(n.parent.id))
  );

  const catalog = [];
  for (const node of assets) {
    catalog.push({
      id: node.id,
      name: node.name || "Untitled",
      width: Math.round(node.width),
      height: Math.round(node.height),
      preview: await thumbnail(node),
    });
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name));
  figma.ui.postMessage({ type: "catalog", assets: catalog });
}

async function thumbnail(node: SceneNode): Promise<string | null> {
  try {
    const longest = Math.max(node.width, node.height) || 1;
    const scale = Math.min(1, THUMB_MAX_PX / longest);
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    return `data:image/png;base64,${figma.base64Encode(bytes)}`;
  } catch (err) {
    console.error("[thumbnail] failed for", node.name, err);
    return null;
  }
}

// --- Place / Export --------------------------------------------------------

/** Instance the chosen component, detach it to an editable frame, and resize it. */
async function buildResizedFrame(req: PlaceRequest): Promise<FrameNode> {
  const node = await figma.getNodeByIdAsync(req.assetId);
  if (!node) throw new Error("That asset no longer exists. Try Refresh.");

  let instance: InstanceNode;
  if (node.type === "COMPONENT") {
    instance = node.createInstance();
  } else if (node.type === "COMPONENT_SET") {
    instance = node.defaultVariant.createInstance();
  } else {
    throw new Error("Selected asset is not a component.");
  }

  // Detach so the inner layers (background / artwork / text) become editable.
  const frame = instance.detachInstance();

  const W = Math.max(1, Math.round(req.width));
  const H = Math.max(1, Math.round(req.height != null ? req.height : frame.height));
  applyContextResize(frame, W, H, req.threshold, req.anchorH, req.margin);
  return frame;
}

async function placeAsset(req: PlaceRequest): Promise<void> {
  const frame = await buildResizedFrame(req);
  const center = figma.viewport.center;
  frame.x = Math.round(center.x - frame.width / 2);
  frame.y = Math.round(center.y - frame.height / 2);
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.ui.postMessage({ type: "placed", name: frame.name });
  figma.notify(`Placed “${frame.name}” at ${frame.width}×${frame.height}`);
}

async function exportAsset(req: PlaceRequest & { format: ExportFormat }): Promise<void> {
  const frame = await buildResizedFrame(req);
  try {
    const settings: ExportSettings =
      req.format === "SVG"
        ? { format: "SVG" }
        : { format: req.format, constraint: { type: "SCALE", value: 1 } };
    const bytes = await frame.exportAsync(settings);
    figma.ui.postMessage({
      type: "exported",
      name: frame.name,
      format: req.format,
      width: Math.round(frame.width),
      bytes,
    });
    figma.notify(`Exported “${frame.name}” as ${req.format}`);
  } finally {
    frame.remove(); // export-only: don't leave the temp frame behind
  }
}

// --- Context-aware resize --------------------------------------------------

/**
 * Classify a frame's children by role using type + z-order:
 *   background = bottommost RECTANGLE (children[0] is the bottom of the stack)
 *   text       = TEXT nodes (independent; left untouched)
 *   assets     = everything else (the artwork), treated as one bounding box
 */
function classifyFrame(frame: FrameNode): {
  background: RectangleNode | null;
  assets: SceneNode[];
} {
  const kids = frame.children;
  let background: RectangleNode | null = null;
  for (const k of kids) {
    if (k.type === "RECTANGLE") {
      background = k;
      break;
    }
  }
  const assets = kids.filter(
    (k) => k !== (background as SceneNode | null) && k.type !== "TEXT"
  );
  return { background, assets };
}

/**
 * Resize `frame` to W×H, applying per-layer behavior:
 *   - background fills 100% of the frame (gradients stay normalized/proportional)
 *   - artwork repositions to `anchorH` when W >= threshold, else scales-to-fit centered
 *   - text untouched
 */
function applyContextResize(
  frame: FrameNode,
  W: number,
  H: number,
  threshold: number,
  anchorH: "left" | "center" | "right",
  margin: number
): void {
  const m = Math.max(0, margin);
  const { background, assets } = classifyFrame(frame);

  // Asset combined bounding box (frame-local), before resize.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of assets) {
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width);
    maxY = Math.max(maxY, a.y + a.height);
  }
  const bw = maxX - minX;
  const bh = maxY - minY;

  // Resize the frame without disturbing children; we place layers explicitly.
  frame.resizeWithoutConstraints(W, H);

  if (background) {
    background.x = 0;
    background.y = 0;
    background.resize(W, H);
  }

  if (assets.length === 0 || bw <= 0 || bh <= 0) return;

  if (W >= threshold) {
    // Reposition mode: keep artwork size, move to the chosen anchor.
    let targetX: number;
    if (anchorH === "left") targetX = m;
    else if (anchorH === "right") targetX = W - bw - m;
    else targetX = (W - bw) / 2;
    const targetY = (H - bh) / 2;
    const dx = targetX - minX;
    const dy = targetY - minY;
    for (const a of assets) {
      a.x += dx;
      a.y += dy;
    }
  } else {
    // Scale mode: ratio-locked fit to the limiting dimension, then center.
    const factor = Math.min((W - 2 * m) / bw, (H - 2 * m) / bh);
    const originX = (W - bw * factor) / 2;
    const originY = (H - bh * factor) / 2;
    for (const a of assets) {
      const relX = (a.x - minX) * factor;
      const relY = (a.y - minY) * factor;
      if ("rescale" in a && factor > 0) {
        a.rescale(factor);
      } else if ("resize" in a) {
        a.resize(Math.max(1, a.width * factor), Math.max(1, a.height * factor));
      }
      a.x = originX + relX;
      a.y = originY + relY;
    }
  }
}

// --- Import ----------------------------------------------------------------

async function importSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "pick-files" });
    return;
  }

  const created: ComponentNode[] = [];
  let skipped = 0;
  for (const node of selection) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      skipped++;
      continue;
    }
    try {
      created.push(figma.createComponentFromNode(node));
    } catch {
      skipped++;
    }
  }

  if (created.length) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }
  figma.notify(
    created.length
      ? `Converted ${created.length} to component(s)` +
          (skipped ? `, skipped ${skipped}` : "")
      : "Nothing to convert"
  );
  await sendCatalog();
}

async function importFiles(files: ImportFile[]): Promise<void> {
  if (!files.length) return;

  const center = figma.viewport.center;
  let x = Math.round(center.x);
  const y = Math.round(center.y);
  const created: ComponentNode[] = [];

  for (const file of files) {
    let node: SceneNode;
    if (file.format === "SVG" && file.svg) {
      node = figma.createNodeFromSvg(file.svg);
    } else if (file.bytes) {
      const image = figma.createImage(file.bytes);
      const { width, height } = await image.getSizeAsync();
      const rect = figma.createRectangle();
      rect.resize(width, height);
      rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
      node = rect;
    } else {
      continue;
    }
    node.name = file.name;
    const component = figma.createComponentFromNode(node);
    component.name = file.name;
    component.x = x;
    component.y = y;
    x += Math.round(component.width) + 80;
    created.push(component);
  }

  if (created.length) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
    figma.notify(`Imported ${created.length} illustration(s)`);
  }
  await sendCatalog();
}

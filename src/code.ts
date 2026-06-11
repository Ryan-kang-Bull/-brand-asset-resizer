// Brand Asset Resizer — main thread (runs in Figma's sandbox; has the `figma` API).
//
// Lets the product team drop brand-team components onto the canvas at responsive
// breakpoint sizes (or a custom size), and export them as files. The brand team can
// import illustrations (frames on canvas, or uploaded SVG/PNG/JPG) as components.
//
// It only instances existing components — it never generates artwork.

const THUMB_MAX_PX = 240; // longest edge of a thumbnail, in px

type ExportFormat = "PNG" | "SVG" | "JPG";

interface SizeRequest {
  assetId: string;
  width: number;
  height: number;
  lockAspect: boolean;
}

interface ImportFile {
  name: string;
  format: ExportFormat;
  svg?: string; // for SVG uploads
  bytes?: Uint8Array; // for PNG/JPG uploads
}

type UIMessage =
  | { type: "init" }
  | ({ type: "place" } & SizeRequest)
  | ({ type: "export"; format: ExportFormat } & SizeRequest)
  | { type: "import-selection" }
  | { type: "import-files"; files: ImportFile[] };

figma.showUI(__html__, { width: 380, height: 600, themeColors: true });

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

/** Find every component in the file, render a thumbnail, and send the list to the UI. */
async function sendCatalog(): Promise<void> {
  if (typeof figma.loadAllPagesAsync === "function") {
    await figma.loadAllPagesAsync();
  }

  const found = figma.root.findAllWithCriteria({
    types: ["COMPONENT", "COMPONENT_SET"],
  });

  // Drop the individual variants of a component set (they'd duplicate the set).
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

/** Render a node to a small PNG data URI, exactly as it appears on canvas. */
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

/** Create a resized instance of the chosen component. */
async function buildInstance(req: SizeRequest): Promise<InstanceNode> {
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

  const { width, height } = fitSize(
    instance.width,
    instance.height,
    req.width,
    req.height,
    req.lockAspect
  );
  instance.resize(width, height);
  return instance;
}

async function placeAsset(req: SizeRequest): Promise<void> {
  const instance = await buildInstance(req);
  const center = figma.viewport.center;
  instance.x = Math.round(center.x - instance.width / 2);
  instance.y = Math.round(center.y - instance.height / 2);
  figma.currentPage.appendChild(instance);
  figma.currentPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);
  figma.ui.postMessage({ type: "placed", name: instance.name });
  figma.notify(`Placed “${instance.name}” at ${instance.width}×${instance.height}`);
}

async function exportAsset(req: SizeRequest & { format: ExportFormat }): Promise<void> {
  const instance = await buildInstance(req);
  try {
    const settings: ExportSettings =
      req.format === "SVG"
        ? { format: "SVG" }
        : { format: req.format, constraint: { type: "SCALE", value: 1 } };
    const bytes = await instance.exportAsync(settings);
    figma.ui.postMessage({
      type: "exported",
      name: instance.name,
      format: req.format,
      width: Math.round(instance.width),
      bytes,
    });
    figma.notify(`Exported “${instance.name}” as ${req.format}`);
  } finally {
    instance.remove(); // export-only: don't leave the temp node behind
  }
}

/** Final dimensions, optionally preserving aspect ratio (fit within the box). */
function fitSize(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  lockAspect: boolean
): { width: number; height: number } {
  if (!lockAspect) {
    return { width: Math.max(1, targetW), height: Math.max(1, targetH) };
  }
  const scale = Math.min(targetW / srcW, targetH / srcH);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

// --- Import ----------------------------------------------------------------

/** Convert the selected frames/groups into components (in place). */
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

/** Turn uploaded illustrations into components on the page. */
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

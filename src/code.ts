// Brand Asset Resizer — main thread (runs in the Figma sandbox, has the `figma` API).
//
// Responsibilities:
//   1. Scan the current file for brand-approved components (the brand team maintains
//      these as published/library components or in a dedicated "assets" page).
//   2. Send the catalog (name + thumbnail + native size) to the UI iframe.
//   3. On request, clone the chosen component as an instance, resize it to the
//      requested product dimensions, and drop it onto the canvas.
//
// It never *generates* artwork — it only ever instances existing components, which
// keeps everything brand-approved.

const THUMB_MAX_PX = 256;

interface AssetSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  preview: string | null; // data URI (PNG) or null if it couldn't be rendered
}

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
  svg?: string; // present for SVG uploads
  bytes?: Uint8Array; // present for PNG/JPG uploads
}

type UIMessage =
  | { type: "init" }
  | ({ type: "place" } & SizeRequest)
  | ({ type: "export"; format: ExportFormat } & SizeRequest)
  | { type: "import"; files: ImportFile[] }
  | { type: "import-selection" };

figma.showUI(__html__, { width: 400, height: 620, themeColors: true });

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if (msg.type === "init") {
      await sendCatalog();
    } else if (msg.type === "place") {
      await placeAsset(msg);
    } else if (msg.type === "export") {
      await exportAsset(msg);
    } else if (msg.type === "import") {
      await importAssets(msg.files);
    } else if (msg.type === "import-selection") {
      await importSelection();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Brand Asset Resizer]", err);
    figma.ui.postMessage({ type: "error", message });
    figma.notify(`Brand Asset Resizer: ${message}`, { error: true });
  }
};

/** Find every brand component in the file and ship a thumbnail catalog to the UI. */
async function sendCatalog(): Promise<void> {
  // dynamic-page documents require pages to be loaded before a tree-wide search.
  if (typeof figma.loadAllPagesAsync === "function") {
    await figma.loadAllPagesAsync();
  }

  const nodes = figma.root.findAllWithCriteria({
    types: ["COMPONENT", "COMPONENT_SET"],
  });

  // For a component set, the variants are themselves COMPONENTs and would show as
  // duplicates — collapse to just the set.
  const setIds = new Set(
    nodes.filter((n) => n.type === "COMPONENT_SET").map((n) => n.id)
  );
  const assets = nodes.filter((n) => {
    if (n.type === "COMPONENT" && n.parent && setIds.has(n.parent.id)) {
      return false;
    }
    return true;
  });

  const summaries: AssetSummary[] = [];
  for (const node of assets) {
    summaries.push({
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      preview: await renderThumb(node),
    });
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name));
  figma.ui.postMessage({ type: "catalog", assets: summaries });
}

/** Export a small PNG thumbnail of a node as a data URI. */
async function renderThumb(node: SceneNode): Promise<string | null> {
  // These illustrations crop a larger composition, but setting clipsContent on the
  // node doesn't constrain exportAsync. So wrap a clone inside a fresh clipping
  // frame sized to the node's box and export the wrapper — that reliably cuts the
  // overflowing source art down to the intended box. Discard the wrapper after.
  let wrapper: FrameNode | null = null;
  try {
    const w = node.width;
    const h = node.height;
    const longest = Math.max(w, h) || 1;
    const scale = Math.min(1, THUMB_MAX_PX / longest);

    let target: SceneNode = node;
    if ("clone" in node) {
      const clone = node.clone();
      wrapper = figma.createFrame();
      wrapper.resize(w, h);
      wrapper.clipsContent = true;
      wrapper.fills = [];
      wrapper.appendChild(clone);
      clone.x = 0;
      clone.y = 0;
      target = wrapper;
    }

    const bytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    return `data:image/png;base64,${figma.base64Encode(bytes)}`;
  } catch (_err) {
    return null;
  } finally {
    if (wrapper) wrapper.remove();
  }
}

/** Create an instance of the chosen component, resized to the requested size. */
async function buildInstance(req: SizeRequest): Promise<InstanceNode> {
  const node = await figma.getNodeByIdAsync(req.assetId);
  if (!node) {
    throw new Error("That asset no longer exists in this file. Try Refresh.");
  }

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

  // The illustrations crop a larger composition but often ship with clipsContent
  // off; force it on so the placed/exported asset is the intended cropped art,
  // not the overflowing source.
  if ("clipsContent" in instance) {
    instance.clipsContent = true;
  }
  return instance;
}

/** Instance the chosen component, resize it, and place it on the current page. */
async function placeAsset(msg: SizeRequest): Promise<void> {
  const instance = await buildInstance(msg);

  // Drop it at the center of the current viewport.
  const center = figma.viewport.center;
  instance.x = Math.round(center.x - instance.width / 2);
  instance.y = Math.round(center.y - instance.height / 2);

  figma.currentPage.appendChild(instance);
  figma.currentPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);

  figma.ui.postMessage({ type: "placed", name: instance.name });
  figma.notify(`Placed “${instance.name}” at ${instance.width}×${instance.height}`);
}

/** Build a resized instance, export it to file bytes, then discard the temp node. */
async function exportAsset(
  msg: SizeRequest & { format: ExportFormat }
): Promise<void> {
  const instance = await buildInstance(msg);
  try {
    const settings: ExportSettings =
      msg.format === "SVG"
        ? { format: "SVG" }
        : { format: msg.format, constraint: { type: "SCALE", value: 1 } };
    const bytes = await instance.exportAsync(settings);
    figma.ui.postMessage({
      type: "exported",
      name: instance.name,
      format: msg.format,
      width: Math.round(instance.width),
      bytes,
    });
    figma.notify(`Exported “${instance.name}” as ${msg.format}`);
  } finally {
    // Export-only: never leave the temporary node on the canvas.
    instance.remove();
  }
}

/**
 * Brand-team flow: convert the currently-selected frames/groups into components
 * (in place) so they join the library. With nothing selected, ask the UI to open
 * the file picker instead.
 */
async function importSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "pick-files" });
    return;
  }

  const created: ComponentNode[] = [];
  let alreadyComponents = 0;
  let failed = 0;

  for (const node of selection) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      alreadyComponents++;
      continue;
    }
    try {
      created.push(figma.createComponentFromNode(node));
    } catch (_err) {
      failed++;
    }
  }

  if (created.length) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }

  const parts: string[] = [];
  if (created.length) parts.push(`Converted ${created.length} to component(s)`);
  if (alreadyComponents) parts.push(`${alreadyComponents} already component(s)`);
  if (failed) parts.push(`${failed} couldn't convert`);
  figma.notify(parts.length ? parts.join(" · ") : "Nothing to convert");

  await sendCatalog();
}

/**
 * Brand-team flow: turn uploaded illustrations into components on the current
 * page so they become part of the asset library the plugin reads from.
 */
async function importAssets(files: ImportFile[]): Promise<void> {
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
    figma.notify(`Imported ${created.length} illustration(s) as components`);
  }

  // Refresh the catalog so the new components appear in the picker.
  await sendCatalog();
}

/** Compute final dimensions, optionally preserving the asset's aspect ratio. */
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

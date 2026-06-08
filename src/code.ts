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

const THUMB_MAX_PX = 120;

interface AssetSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  preview: string | null; // data URI (PNG) or null if it couldn't be rendered
}

type UIMessage =
  | { type: "init" }
  | {
      type: "place";
      assetId: string;
      width: number;
      height: number;
      lockAspect: boolean;
    };

figma.showUI(__html__, { width: 320, height: 560, themeColors: true });

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if (msg.type === "init") {
      await sendCatalog();
    } else if (msg.type === "place") {
      await placeAsset(msg);
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
  try {
    const longest = Math.max(node.width, node.height) || 1;
    const scale = Math.min(1, THUMB_MAX_PX / longest);
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    return `data:image/png;base64,${figma.base64Encode(bytes)}`;
  } catch {
    return null;
  }
}

/** Instance the chosen component, resize it, and place it on the current page. */
async function placeAsset(msg: Extract<UIMessage, { type: "place" }>): Promise<void> {
  const node = await figma.getNodeByIdAsync(msg.assetId);
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
    msg.width,
    msg.height,
    msg.lockAspect
  );
  instance.resize(width, height);

  // Drop it at the center of the current viewport.
  const center = figma.viewport.center;
  instance.x = Math.round(center.x - width / 2);
  instance.y = Math.round(center.y - height / 2);

  figma.currentPage.appendChild(instance);
  figma.currentPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);

  figma.ui.postMessage({ type: "placed", name: instance.name });
  figma.notify(`Placed “${instance.name}” at ${width}×${height}`);
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

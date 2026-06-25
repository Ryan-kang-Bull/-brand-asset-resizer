// Injects catalog.json into the compiled build/code.js.
//
// The shared library catalog can't be a runtime `import` — Figma loads a single
// bundled code.js with no module loader. So code.ts ships a sentinel array
// literal, and this script replaces it with the contents of catalog.json after
// tsc runs. Editing the library = edit catalog.json, rebuild, republish.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const catalogPath = path.join(root, "catalog.json");
const codePath = path.join(root, "build", "code.js");
const MARKER = "[] /* __INJECT_CATALOG__ */";

let raw = "[]";
try {
  raw = fs.readFileSync(catalogPath, "utf8").trim() || "[]";
} catch {
  console.warn("[inject-catalog] no catalog.json found — injecting empty catalog.");
}

let entries;
try {
  entries = JSON.parse(raw);
} catch (err) {
  console.error("[inject-catalog] catalog.json is not valid JSON:", err.message);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error("[inject-catalog] catalog.json must be a JSON array.");
  process.exit(1);
}

let code = fs.readFileSync(codePath, "utf8");
if (!code.includes(MARKER)) {
  console.error(`[inject-catalog] marker not found in build/code.js: ${MARKER}`);
  process.exit(1);
}
code = code.replace(MARKER, JSON.stringify(entries));
fs.writeFileSync(codePath, code);
console.log(`[inject-catalog] injected ${entries.length} catalog entr(y/ies).`);

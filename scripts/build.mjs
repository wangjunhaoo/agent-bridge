import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const distExtension = path.join(rootDir, "dist", "extension");
const distHost = path.join(rootDir, "dist", "host");

fs.rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
fs.mkdirSync(distExtension, { recursive: true });
fs.mkdirSync(distHost, { recursive: true });

// 1. 打包 Chrome Extension Service Worker & Panel (ESM)
await build({
  entryPoints: [
    path.join(rootDir, "src/extension/background.ts"),
    path.join(rootDir, "src/extension/panel.ts")
  ],
  outdir: distExtension,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false
});

// 2. 打包 Content Script (IIFE 格式，兼容 manifest content_scripts 与 scripting.executeScript)
await build({
  entryPoints: [path.join(rootDir, "src/extension/content.ts")],
  outfile: path.join(distExtension, "content.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: false
});

// 3. 复制扩展静态资源 (manifest.json, panel.html)
fs.copyFileSync(
  path.join(rootDir, "src/extension/manifest.json"),
  path.join(distExtension, "manifest.json")
);
fs.copyFileSync(
  path.join(rootDir, "src/extension/panel.html"),
  path.join(distExtension, "panel.html")
);

// 4. 打包本地 Host / MCP Server / CLI
await build({
  entryPoints: [path.join(rootDir, "src/host/cli.ts")],
  outfile: path.join(distHost, "cli.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node"
  }
});

fs.chmodSync(path.join(distHost, "cli.js"), 0o755);
console.log("Build completed successfully: dist/extension & dist/host/cli.js");

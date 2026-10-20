// Renders the social preview image and the README banners with headless Chromium.
// Run `node docs/scripts/og-images.mjs` after you change the copy or the layout.
// The docs package does not depend on Playwright, so this script borrows the copy from @vite-hub/browser.
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(repoRoot, "packages/browser/package.json"));
const { chromium } = require("playwright-core");

const icons = JSON.parse(
  await readFile(join(repoRoot, "docs/node_modules/@iconify-json/simple-icons/icons.json"), "utf8"),
).icons;
const mark = (await readFile(join(repoRoot, "docs/public/vitehub-mark.svg"), "utf8")).match(/ d="([^"]+)"/)[1];

const outputs = [
  { file: "docs/public/og/vitehub.png", size: "og", theme: "dark", width: 1200, height: 630, scale: 1 },
  { file: ".github/assets/readme-banner-dark.png", size: "banner", theme: "dark", width: 2000, height: 700, scale: 1.6 },
  { file: ".github/assets/readme-banner-light.png", size: "banner", theme: "light", width: 2000, height: 700, scale: 1.6 },
];

function chromiumExecutable() {
  const configured = process.env.OG_CHROMIUM_PATH;
  if (configured) return configured;

  const command = process.platform === "win32" ? "where.exe" : "which";
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync(command, [name], { encoding: "utf8" }).trim().split(/\r?\n/, 1)[0];
    } catch {
      // Try the next common Chromium command.
    }
  }

  throw new Error(
    "Could not find a Chromium executable. Install Chromium or set OG_CHROMIUM_PATH to its executable path, then rerun node docs/scripts/og-images.mjs.",
  );
}

const hosts = [
  { name: "Cloudflare", icon: "cloudflare" },
  { name: "Vercel", icon: "vercel" },
  { name: "Netlify", icon: "netlify" },
  { name: "Deno", icon: "deno" },
  { name: "Node", icon: "nodedotjs" },
];

// The route from the README "Write once, deploy anywhere" section.
const code = [
  [["k", "import"], ["", " { defineEventHandler } "], ["k", "from"], ["s", ' "h3"'], ["", ";"]],
  [["k", "import"], ["", " { kv } "], ["k", "from"], ["s", ' "vite-hub/kv"'], ["", ";"]],
  [],
  [["k", "export default"], ["f", " defineEventHandler"], ["", "("], ["k", "async"], ["", " () => {"]],
  [["", "  "], ["k", "const"], ["", " [error, settings] = "], ["k", "await"], ["", " kv."], ["f", "get"], ["", "("], ["s", '"settings"'], ["", ");"]],
  [["", "  "], ["k", "if"], ["", " (error) "], ["k", "throw"], ["", " error;"]],
  [["", "  "], ["k", "return"], ["", " settings;"]],
  [["", "});"]],
];

const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function codeHtml() {
  return code
    .map((line) => `<div>${line.map(([kind, text]) => `<span class="${kind}">${escape(text)}</span>`).join("") || "&nbsp;"}</div>`)
    .join("");
}

// Route rails from the code panel to each host, ending on an endpoint dot.
function railsSvg() {
  const width = 1000;
  const height = 100;
  const step = width / hosts.length;
  const paths = hosts.map((_, index) => {
    const x = step * index + step / 2;
    return `<path d="M500 0V36Q500 50 ${500 + Math.sign(x - 500) * 14} 50H${x - Math.sign(x - 500) * 14}Q${x} 50 ${x} 64V100" />`;
  });
  return `<svg class="rails" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${paths.join("")}</svg>`;
}

function hostsHtml() {
  return hosts
    .map(
      (host) => `<div class="host"><span class="dot"></span><svg viewBox="0 0 24 24">${icons[host.icon].body}</svg><span>${host.name}</span></div>`,
    )
    .join("");
}

function page({ size, theme, width, height }) {
  return `<!doctype html>
<html class="${size} ${theme}">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=block">
<style>
* { box-sizing: border-box; margin: 0; }
html { width: ${width}px; height: ${height}px; overflow: hidden; }
.dark {
  --canvas: #09090b; --raised: #111113; --line: #27272a; --grid: rgb(255 255 255 / 0.045);
  --text: #e4e4e7; --high: #fafafa; --muted: #a1a1aa; --dim: #52525b; --rail: #3f3f46;
}
.light {
  --canvas: #ffffff; --raised: #fafafa; --line: #e4e4e7; --grid: rgb(9 9 11 / 0.04);
  --text: #3f3f46; --high: #18181b; --muted: #71717a; --dim: #a1a1aa; --rail: #d4d4d8;
}
.og { --pad-x: 72px; --pad-y: 64px; --brand: 30px; --title: 68px; --lead: 23px; --mono: 14px; --panel: 500px; --chip: 18px; --gap: 40px; }
.banner { --pad-x: 120px; --pad-y: 96px; --brand: 40px; --title: 108px; --lead: 32px; --mono: 21px; --panel: 760px; --chip: 24px; --gap: 120px; }
body {
  position: relative; width: 100%; height: 100%;
  display: flex; align-items: stretch; gap: var(--gap);
  padding: var(--pad-y) var(--pad-x);
  background: var(--canvas); color: var(--text);
  font-family: Geist, sans-serif; -webkit-font-smoothing: antialiased;
}
/* Square grid that fades out toward the copy. */
body::before {
  content: ""; position: absolute; inset: 0; z-index: 0;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 40px 40px; background-position: -1px -1px;
  mask-image: linear-gradient(90deg, transparent 15%, #000 70%);
}
/* The baseline that the mark sits on. */
body::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: calc(var(--pad-y) * 0.55); height: 1px; background: var(--line);
}
.copy, .diagram { position: relative; z-index: 1; display: flex; flex-direction: column; }
.copy { flex: 1; justify-content: space-between; min-width: 0; }
.brand { display: flex; align-items: center; gap: calc(var(--brand) * 0.42); font-size: var(--brand); font-weight: 600; color: var(--high); letter-spacing: -0.02em; }
.brand svg { width: calc(var(--brand) * 1.15); height: auto; fill: var(--high); }
h1 { font-size: var(--title); font-weight: 600; line-height: 0.98; letter-spacing: -0.06em; color: var(--high); }
h1 span { color: var(--muted); }
.lead { margin-top: calc(var(--lead) * 1); max-width: 24em; font-size: var(--lead); line-height: 1.35; color: var(--muted); letter-spacing: -0.01em; }
.install { display: flex; align-items: center; gap: calc(var(--mono) * 1.6); font-family: "Geist Mono", monospace; font-size: calc(var(--mono) * 1.15); }
.install code { padding: 0.7em 1em; border: 1px solid var(--line); background: var(--raised); color: var(--high); }
.install code b { font-weight: 400; color: var(--dim); }
.install .url { color: var(--muted); }
.diagram { width: var(--panel); justify-content: center; }
.panel { border: 1px solid var(--line); background: var(--raised); font-family: "Geist Mono", monospace; font-size: var(--mono); }
.panel header { display: flex; align-items: center; justify-content: space-between; padding: 0.75em 1.1em; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 0.85em; }
.panel header i { font-style: normal; color: var(--dim); }
.panel pre { padding: 1.1em 1.1em 1.2em; line-height: 1.65; color: var(--text); white-space: pre; }
.k { color: var(--high); font-weight: 500; }
.f { color: var(--high); }
.s { color: var(--muted); }
.rails { display: block; width: 100%; height: calc(var(--chip) * 3.4); overflow: visible; }
.rails path { fill: none; stroke: var(--rail); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.hosts { display: grid; grid-template-columns: repeat(${hosts.length}, 1fr); }
.host { display: flex; flex-direction: column; align-items: center; gap: calc(var(--chip) * 0.45); font-size: calc(var(--chip) * 0.78); color: var(--muted); }
.host .dot { width: calc(var(--chip) * 0.45); height: calc(var(--chip) * 0.45); margin-top: calc(var(--chip) * -0.225); border-radius: 50%; background: var(--canvas); border: 1.5px solid var(--muted); }
.host svg { width: calc(var(--chip) * 1.6); height: calc(var(--chip) * 1.6); color: var(--high); margin-top: calc(var(--chip) * 0.25); }
</style>
</head>
<body>
  <section class="copy">
    <div class="brand"><svg viewBox="0 0 20 18"><path d="${mark}"/></svg>ViteHub</div>
    <div>
      <h1>The server layer<br><span>for Vite apps.</span></h1>
      <p class="lead">Databases, storage, queues, workflows, and Agents. One API in your app, any cloud you choose.</p>
    </div>
    <div class="install"><code><b>$</b> pnpm add vite-hub</code><span class="url">vitehub.dev</span></div>
  </section>
  <section class="diagram">
    <div class="panel">
      <header><span>server/api/settings.get.ts</span><i>one route</i></header>
      <pre>${codeHtml()}</pre>
    </div>
    ${railsSvg()}
    <div class="hosts">${hostsHtml()}</div>
  </section>
</body>
</html>`;
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
try {
  for (const output of outputs) {
    const context = await browser.newContext({
      viewport: { width: output.width, height: output.height },
      deviceScaleFactor: output.scale,
    });
    const tab = await context.newPage();
    await tab.setContent(page(output), { waitUntil: "networkidle" });
    await tab.evaluate(() => document.fonts.ready);
    const path = join(repoRoot, output.file);
    await mkdir(dirname(path), { recursive: true });
    await tab.screenshot({ path, type: "png" });
    await context.close();
    console.log(`wrote ${output.file}`);
  }
}
finally {
  await browser.close();
}

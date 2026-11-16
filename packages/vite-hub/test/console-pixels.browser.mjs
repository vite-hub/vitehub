// Pixel oracle for the Console. It captures every Console route of `playground/console` in light and dark, at 1280px
// and 390px, and compares two captures pixel by pixel. A change that must not move pixels, such as a token rename,
// shows a zero diff. From the repository root:
//
//   node packages/vite-hub/test/console-pixels.browser.mjs capture .cache/console-pixels/base   # on the base commit
//   node packages/vite-hub/test/console-pixels.browser.mjs capture .cache/console-pixels/head   # on your branch
//   node packages/vite-hub/test/console-pixels.browser.mjs compare .cache/console-pixels/base .cache/console-pixels/head
//
// `capture` starts the playground on `--port` (default 4381) and stops it when it ends. `--url <origin>` uses a
// playground that already runs. `--only <text>` captures only the paths that contain the text. The playground loads the
// Console from source, so build only its dependencies once: `corepack pnpm exec vp run --cache -t @vite-hub/auth#build`.
// `capture` also fails a shot when a `.ui-sdk` scope root holds a Nuxt UI component (see `nuxtUIInScopes`).
//
// `compare` prints the changed-pixel share of each shot, writes a diff image of each changed shot to `--diff <dir>`
// (default `<head>-diff`), and exits with 1 when a shot is missing or its share is above `--threshold` (percent,
// default 0.01).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
// The playground fixtures and the Console show dates relative to now. The browser and the playground process both see
// this instant, so relative times are the same in every capture.
const now = "2026-11-15T12:00:00.000Z";
const schemes = ["light", "dark"];
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    diff: { type: "string" },
    only: { type: "string" },
    port: { type: "string", default: "4381" },
    threshold: { type: "string", default: "0.01" },
    url: { type: "string" },
  },
});
const [command, ...folders] = positionals;

if (command === "capture" && folders.length === 1) await capture(resolve(folders[0]));
else if (command === "compare" && folders.length === 2) process.exitCode = await compare(resolve(folders[0]), resolve(folders[1]));
else {
  console.error("Usage: console-pixels.browser.mjs capture <dir> [--port 4381] [--url <origin>] [--only <text>]\n       console-pixels.browser.mjs compare <base> <head> [--threshold 0.01] [--diff <dir>]");
  process.exitCode = 2;
}

async function capture(folder) {
  const started = performance.now();
  const server = options.url ? undefined : await startPlayground(Number(options.port));
  const origin = options.url ?? server.origin;
  // One raster thread: with more, an antialiased edge sometimes differed by one color step between two captures.
  const browser = await chromium.launch({ args: ["--num-raster-threads=1", "--disable-partial-raster"] });
  try {
    await rm(folder, { force: true, recursive: true });
    await mkdir(folder, { recursive: true });
    const first = await openContext(browser, schemes[0], viewports[0]);
    const targets = await discoverTargets(first, origin, folder);
    await first.context.close();
    const shots = [...targets.shots];
    for (const scheme of schemes) {
      for (const viewport of viewports) {
        if (scheme === schemes[0] && viewport === viewports[0]) continue;
        const session = await openContext(browser, scheme, viewport);
        for (const target of targets.paths) shots.push(await shoot(session, origin, target, folder));
        await session.context.close();
      }
    }
    const seconds = Math.round((performance.now() - started) / 1000);
    await writeFile(join(folder, "manifest.json"), `${JSON.stringify({ now, seconds, routes: targets.routes, shots }, null, 2)}\n`);
    const unstable = shots.filter((shot) => !shot.stable);
    console.log(`${shots.length} shots of ${targets.paths.length} paths in ${seconds}s -> ${folder}`);
    for (const route of targets.routes.filter((entry) => !entry.shot)) console.log(`not captured: ${route.path} (${route.reason})`);
    for (const shot of unstable) console.log(`failed: ${shot.file} (${shot.reason})`);
    if (unstable.length) process.exitCode = 1;
  }
  finally {
    await browser.close();
    await server?.stop();
  }
}

/** Starts `playground/console` with a fixed clock on a free port and returns a handle that stops only that process. */
async function startPlayground(port) {
  await assertPortFree(port);
  const clock = `const t=Date.parse(${JSON.stringify(now)}),D=Date;globalThis.Date=class extends D{constructor(...a){a.length?super(...a):super(t)}static now(){return t}}`;
  const child = spawn(join(repositoryRoot, "node_modules/.bin/vp"), ["dev", "--config", "playground/console/vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repositoryRoot,
    // A process group, so stopping it also stops the Node process that `vp` starts.
    detached: true,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "data:text/javascript,${encodeURIComponent(clock)}"`, TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The playground stopped:\n${log}`);
    const ready = await fetch(`${origin}/_vitehub/`).then((response) => response.ok, () => false);
    if (ready) {
      console.log(`playground pid ${child.pid} on ${origin}`);
      return { origin, stop };
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  await stop();
  throw new Error(`The playground did not answer on ${origin} in 120 seconds:\n${log}`);
}

function assertPortFree(port) {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", () => fail(new Error(`Port ${port} is in use. Pass a free one with --port.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(done));
  });
}

async function openContext(browser, scheme, viewport) {
  const context = await browser.newContext({
    colorScheme: scheme,
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport,
  });
  await context.clock.setFixedTime(now);
  // Transitions would show a frame between two states. Animations stop in the screenshot call.
  await context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important;caret-color:transparent!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  });
  const page = await context.newPage();
  // Requests that are still open. Vite's HMR socket is not a request.
  const open = new Set();
  page.on("request", (request) => open.add(request));
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => open.delete(request));
  // Errors of the page, to say why the Console did not mount.
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return { context, errors, open, page, scheme, viewport };
}

/**
 * Reads the routes from the Console router and captures the first scheme and width. A route without parameters, or with
 * optional ones, is captured at its plain path. An optional parameter with a fixed list, such as
 * `:page(overview|users)?`, is captured once per value. A required parameter takes a value from a page that the
 * Console opened by itself, such as `/agents` opening its first session. Paths that land on a page that is already
 * captured are skipped.
 */
async function discoverTargets(session, origin, folder) {
  await settle(session, `${origin}/_vitehub/`);
  // Contributed sections add their routes when the navigation answer arrives.
  const records = await session.page.evaluate(async () => {
    const router = document.querySelector("#app").__vue_app__.config.globalProperties.$router;
    let count = -1;
    while (count !== router.getRoutes().length) {
      count = router.getRoutes().length;
      await new Promise((done) => setTimeout(done, 500));
    }
    return router.getRoutes().filter((route) => !route.redirect).map((route) => ({ name: String(route.name), path: route.path }));
  });
  records.sort((a, b) => a.path.localeCompare(b.path));
  const routes = records.map((record) => ({ ...record, shot: undefined, reason: undefined }));
  const landed = new Map();
  const known = [];
  const shots = [];
  const paths = [];
  const visit = async (path, route) => {
    if (options.only && !path.includes(options.only)) {
      route.reason ??= "left out by --only";
      return;
    }
    const shot = await shoot(session, origin, path, folder);
    if (landed.has(shot.landed)) {
      route.reason ??= `${path} opens ${shot.landed}, captured from ${landed.get(shot.landed)}`;
      await rm(join(folder, shot.file));
      return;
    }
    landed.set(shot.landed, path);
    known.push(shot.params);
    shots.push(shot);
    paths.push(path);
    for (const entry of routes) if (entry.name === shot.route) entry.shot ??= shot.file;
    route.shot ??= shot.file;
  };
  for (const route of routes) {
    if (routeParams(route.path).some((param) => !param.optional)) continue;
    for (const path of expandOptional(route.path)) await visit(path, route);
  }
  for (const route of routes.filter((entry) => !entry.shot && !entry.reason)) {
    const names = routeParams(route.path).filter((param) => !param.optional).map((param) => param.name);
    const params = known.find((entry) => names.every((name) => entry[name]));
    if (!params) {
      route.reason = "no page gives a value for its parameters";
      continue;
    }
    const path = await session.page.evaluate(({ name, params }) => {
      const router = document.querySelector("#app").__vue_app__.config.globalProperties.$router;
      return router.resolve({ name, params }).fullPath;
    }, { name: route.name, params: Object.fromEntries(names.map((name) => [name, params[name]])) });
    await visit(path, route);
  }
  return { paths, routes: routes.map(({ name, path, reason, shot }) => ({ name, path, ...(shot ? { shot } : { reason }) })), shots };
}

/** The parameters of a route path: `/agents/:agent/:tab(a|b)?` gives `agent` (required) and `tab` (optional). */
function routeParams(path) {
  return [...path.matchAll(/:(\w+)(?:\([^)]*\))?([?*+]?)/g)].map(([, name, modifier]) => ({ name, optional: modifier === "?" || modifier === "*" }));
}

/** `/auth/:page(overview|users)?` gives `/auth`, `/auth/overview`, and `/auth/users`. Other optional parameters are left out. */
function expandOptional(path) {
  const match = path.match(/\/:\w+(?:\(([^)]*)\))?[?*]/);
  if (!match) return [path];
  const values = match[1] && /^[\w-]+(\|[\w-]+)*$/.test(match[1]) ? match[1].split("|") : [];
  return ["", ...values.map((value) => `/${value}`)].flatMap((value) => expandOptional(path.replace(match[0], value) || "/"));
}

async function shoot(session, origin, path, folder) {
  const { page, scheme, viewport } = session;
  const busy = await settle(session, `${origin}/_vitehub${path}`);
  const current = await page.evaluate(() => {
    const route = document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value;
    return { landed: route.fullPath, params: { ...route.params }, route: String(route.name) };
  });
  // Playwright stops finite animations at their end and infinite ones at their start. Take shots until two are equal.
  let previous;
  let image;
  let tries = 0;
  for (; tries < 8; tries++) {
    image = await page.screenshot({ animations: "disabled", caret: "hide" });
    if (previous?.equals(image)) break;
    previous = image;
    await page.waitForTimeout(250);
  }
  const file = `${scheme}-${viewport.width}-${path === "/" ? "home" : path.slice(1).replaceAll("/", "_")}.png`;
  await writeFile(join(folder, file), image);
  const scopes = await page.evaluate(nuxtUIInScopes);
  const reason = busy
    ?? (scopes.nuxtUI === 0 ? "no Nuxt UI component found on the page, so the scope check cannot see one" : undefined)
    ?? (scopes.inside.length ? `a .ui-sdk scope root holds Nuxt UI: ${scopes.inside.join(", ")}` : undefined)
    ?? (tries === 8 ? "the page kept changing" : undefined);
  return { file, path, ...current, stable: !reason, ...(reason ? { reason } : {}) };
}

/**
 * Runs in the page. A `.ui-sdk` scope root holds no Nuxt UI component: inside it, the scoped kit family restyles every
 * `[data-slot]`, and 8 slot names (`button`, `input`, `label`, ...) are the same in Nuxt UI and ui-sdk, so a slot name
 * cannot tell them apart. The Vue component that renders an element can: in the dev build, each element knows its
 * component, and each Nuxt UI component knows its file under `@nuxt/ui`. Returns the Nuxt UI components whose output
 * starts inside a scope root, and how many elements Nuxt UI renders on the page (zero means the check went blind).
 */
function nuxtUIInScopes() {
  const fromNuxtUI = (instance) => /[\\/]@nuxt[\\/]ui[\\/]/.test(instance.type.__file ?? "");
  let nuxtUI = 0;
  for (const element of document.querySelectorAll("*")) if (element.__vueParentComponent && fromNuxtUI(element.__vueParentComponent)) nuxtUI++;
  const inside = new Set();
  for (const root of document.querySelectorAll(".ui-sdk")) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      // Walk up the components that render this element while their output starts inside the root, and keep the outermost
      // Nuxt UI one (UButton, not the ULinkBase inside it). A Nuxt UI component around the root, such as a card with a
      // scope root in its slot, starts outside it and ends the walk.
      let outermost;
      for (let instance = element.__vueParentComponent; instance; instance = instance.parent) {
        const start = instance.subTree?.el ?? instance.vnode.el;
        if (!(start instanceof Node) || !root.contains(start)) break;
        if (fromNuxtUI(instance)) outermost = instance;
      }
      if (outermost) inside.add(outermost);
    }
  }
  const describe = (instance) => {
    const start = instance.subTree?.el ?? instance.vnode.el;
    const slot = start instanceof Element ? start.getAttribute("data-slot") : null;
    return `U${instance.type.__file.split(/[\\/]/).pop().replace(/\.vue$/, "")}${slot ? ` [data-slot="${slot}"]` : ""}`;
  };
  return { inside: [...new Set([...inside].map(describe))], nuxtUI };
}

/**
 * Opens a path and waits until no request is open for 500 ms and no spinner shows, then for fonts, images, and two
 * frames. A page that loads its code between two requests shows a spinner, so the quiet window alone is not enough.
 * Returns why the page did not settle in 30 seconds.
 */
async function settle(session, url) {
  const { errors, open, page, viewport } = session;
  open.clear();
  errors.length = 0;
  await page.goto(url);
  // On a cold start, Vite optimizes dependencies and reloads the page, so the requests can stop before the Console
  // mounts. Wait for the Vue app and its router first.
  await page.waitForFunction(() => document.querySelector("#app")?.__vue_app__?.config.globalProperties.$router, null, { timeout: 120_000 })
    .catch((error) => { throw new Error(`The Console did not mount on ${url}. Page errors:\n${errors.join("\n") || "none"}`, { cause: error }); });
  // The headless pointer starts at 0,0 over the rail, and the rail expands over the page on hover.
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  const deadline = Date.now() + 30_000;
  let quietSince = Date.now();
  let spinning = false;
  while (Date.now() < deadline) {
    if (open.size) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) {
      spinning = await page.evaluate(() => Boolean(document.querySelector('[class*="animate-spin"], [aria-busy="true"]')));
      if (!spinning) break;
    }
    await page.waitForTimeout(50);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((image) => !image.complete).map((image) => new Promise((done) => { image.onload = image.onerror = done; })));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  if (open.size) return `requests still open: ${[...open].map((request) => request.url()).join(", ")}`;
  if (spinning) return "a spinner still shows";
}

async function compare(base, head) {
  const threshold = Number(options.threshold);
  const diffFolder = resolve(options.diff ?? `${head}-diff`);
  const list = async (folder) => existsSync(folder) ? (await readdir(folder)).filter((file) => file.endsWith(".png")).sort() : [];
  const [baseFiles, headFiles] = await Promise.all([list(base), list(head)]);
  const files = [...new Set([...baseFiles, ...headFiles])].sort();
  if (!files.length) {
    console.error(`No PNG files in ${base} or ${head}.`);
    return 2;
  }
  await rm(diffFolder, { force: true, recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  let identical = 0;
  try {
    const page = await browser.newPage();
    for (const file of files) {
      if (!baseFiles.includes(file) || !headFiles.includes(file)) {
        console.log(`missing  ${file} (only in ${baseFiles.includes(file) ? basename(base) : basename(head)})`);
        failed++;
        continue;
      }
      const [a, b] = await Promise.all([readFile(join(base, file)), readFile(join(head, file))]);
      const result = a.equals(b) ? { changed: 0, total: 1 } : await page.evaluate(diffImages, [a.toString("base64"), b.toString("base64")]);
      const share = (result.changed / result.total) * 100;
      const over = result.sizes ? true : share > threshold;
      if (!result.changed) identical++;
      else {
        await mkdir(diffFolder, { recursive: true });
        if (result.image) await writeFile(join(diffFolder, file), Buffer.from(result.image, "base64"));
      }
      if (over) failed++;
      if (result.changed) console.log(`${over ? "changed " : "below   "} ${file} ${result.sizes ?? `${result.changed} px, ${share.toFixed(4)}%`}`);
    }
  }
  finally {
    await browser.close();
  }
  console.log(`${files.length} shots: ${identical} identical, ${files.length - identical - failed} below ${threshold}%, ${failed} over or missing${files.length > identical ? `; diff images in ${diffFolder}` : ""}`);
  return failed ? 1 : 0;
}

/** Runs in the browser: counts the pixels that differ and draws them red over a faded copy of the base. */
async function diffImages([baseData, headData]) {
  const decode = async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { canvas, context, pixels: context.getImageData(0, 0, bitmap.width, bitmap.height) };
  };
  const [a, b] = await Promise.all([decode(baseData), decode(headData)]);
  if (a.pixels.width !== b.pixels.width || a.pixels.height !== b.pixels.height) {
    return { changed: 1, total: 1, sizes: `size ${a.pixels.width}x${a.pixels.height} -> ${b.pixels.width}x${b.pixels.height}` };
  }
  const out = a.context.createImageData(a.pixels.width, a.pixels.height);
  let changed = 0;
  for (let index = 0; index < a.pixels.data.length; index += 4) {
    const same = a.pixels.data[index] === b.pixels.data[index] && a.pixels.data[index + 1] === b.pixels.data[index + 1] && a.pixels.data[index + 2] === b.pixels.data[index + 2] && a.pixels.data[index + 3] === b.pixels.data[index + 3];
    if (!same) changed++;
    const gray = (a.pixels.data[index] + a.pixels.data[index + 1] + a.pixels.data[index + 2]) / 3;
    out.data.set(same ? [gray, gray, gray, 48] : [255, 0, 0, 255], index);
  }
  a.context.putImageData(out, 0, 0);
  const blob = await a.canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { changed, total: a.pixels.width * a.pixels.height, image: btoa(binary) };
}

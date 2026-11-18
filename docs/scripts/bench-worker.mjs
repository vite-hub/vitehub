// Measure the built docs Worker: bundle bytes, Worker start time, cold and
// warm page latency, and workerd peak memory. Plain Node, no dependencies
// beyond the wrangler that docs already installs.
//
//   node docs/scripts/bench-worker.mjs run [--server docs/.output/server] [--out result.json]
//   node docs/scripts/bench-worker.mjs compare base.json branch.json
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

// Fixed list so two runs measure the same work: HTML pages of different
// sizes, a diagnostics page, a 404 that the Worker renders, and the agent
// endpoints, some of which read the whole corpus.
const pages = [
  "/",
  "/docs",
  "/docs/getting-started",
  "/docs/kv",
  "/docs/database",
  "/docs/agents",
  "/docs/agents/channels",
  "/docs/cli/reference",
  "/docs/console",
  "/docs/reference/doctor-rules",
  "/docs/reference/errors-diagnostics",
  "/docs/kv/diagnostics/kv_disabled",
  "/docs/no-such-page",
  "/docs/kv.md",
  "/raw/docs/database.md",
  "/api/_docs/page/docs/kv.json",
  "/api/_docs/search.json",
  "/llms.txt",
  "/llms-full.txt",
  "/openapi.json",
];

// Cold p95 above this ratio is a regression (plan oracle O4).
const coldRegression = 1.5;

const defaults = { server: "docs/.output/server", port: 4813, startup: 10, cold: 10, warmup: 2, warm: 10 };

const require = createRequire(import.meta.url);
const wranglerPackage = realpathSync(require.resolve("wrangler/package.json"));
const wranglerBin = join(dirname(wranglerPackage), JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler);
const quietEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };

function parseFlags(argv) {
  const flags = { ...defaults };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!name || !(name in defaults || name === "out") || value === undefined) throw new Error(`Unknown or incomplete flag: ${argv[index]}`);
    flags[name] = typeof defaults[name] === "number" ? Number(value) : value;
  }
  return flags;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function summary(values) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), min: values.length ? round(Math.min(...values)) : null, max: values.length ? round(Math.max(...values)) : null };
}

/** Bundle the Worker the way `wrangler deploy` uploads it, offline. */
function bundle(server, outdir) {
  const result = spawnSync(process.execPath, [wranglerBin, "deploy", "--dry-run", "--config", join(server, "wrangler.json"), "--outdir", outdir], { env: quietEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`wrangler deploy --dry-run failed:\n${result.stdout}${result.stderr}`);
  const upload = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(result.stdout);
  if (!upload) throw new Error(`No upload size in Wrangler's report:\n${result.stdout}`);
  const modules = readdirSync(outdir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== "README.md" && !entry.name.endsWith(".map"))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const bytes = readFileSync(path);
      return { name: relative(outdir, path), bytes: bytes.length, gzip: gzipSync(bytes).length };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const config = JSON.parse(readFileSync(join(server, "wrangler.json"), "utf8"));
  const assets = config.assets?.directory ? resolve(server, config.assets.directory) : null;
  const assetFiles = assets ? readdirSync(assets, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()) : [];
  return {
    bytes: modules.reduce((total, module) => total + module.bytes, 0),
    // Wrangler compresses all modules together and rounds its report to 0.01 KiB.
    gzip: Math.round(Number(upload[2]) * 1024),
    wranglerUploadKiB: Number(upload[1]),
    wranglerGzipKiB: Number(upload[2]),
    modules,
    assets: { files: assetFiles.length, bytes: assetFiles.reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0) },
  };
}

const moduleTypes = { ".js": "esModule", ".mjs": "esModule", ".cjs": "commonJsModule", ".wasm": "wasm", ".txt": "text", ".html": "text", ".bin": "data" };

// Embed paths are relative to the config file, which sits next to the modules.
function workerdConfig(worker, port) {
  const modules = worker.modules.map(module => `(name = ${JSON.stringify(module.name)}, ${module.type} = embed ${JSON.stringify(module.file)})`).join(", ");
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (modules = [${modules}], compatibilityDate = ${JSON.stringify(worker.compatibilityDate)}, compatibilityFlags = ${JSON.stringify(worker.compatibilityFlags)}))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
`;
}

/**
 * Time from spawning workerd until its control-pipe listen event, emitted
 * after module compilation and top-level initialization. TCP binds earlier.
 * No request is sent. The empty Worker run removes process start from the number.
 */
async function startup(server, outdir, samples, port) {
  const workerd = createRequire(createRequire(wranglerPackage).resolve("miniflare"))("workerd").default;
  const config = JSON.parse(readFileSync(join(server, "wrangler.json"), "utf8"));
  const base = { compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags ?? [] };
  const modules = readdirSync(outdir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(outdir, join(entry.parentPath, entry.name))).filter(name => name !== "README.md" && !name.endsWith(".map") && !name.endsWith(".capnp")).map((name) => {
    const type = moduleTypes[name.slice(name.lastIndexOf("."))];
    if (!type) throw new Error(`No module type for ${name} in ${outdir}.`);
    return { name, type, file: name };
  });
  // The entry module must come first.
  modules.sort((a, b) => Number(b.name === "index.js") - Number(a.name === "index.js"));
  writeFileSync(join(outdir, "empty.mjs.txt"), "export default { fetch() { return new Response('ok') } }");
  const builds = {
    empty: { ...base, modules: [{ name: "index.js", type: "esModule", file: "empty.mjs.txt" }] },
    worker: { ...base, modules },
  };
  for (const [name, build] of Object.entries(builds)) writeFileSync(join(outdir, `${name}.capnp`), workerdConfig(build, port));
  const times = { empty: [], worker: [] };
  const memory = { empty: [], worker: [] };
  if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use. Pass --port with a free port.`);
  // Interleave so machine load hits both the same way.
  for (let sample = 0; sample < samples; sample++) {
    for (const name of ["empty", "worker"]) {
      const started = performance.now();
      const child = spawn(workerd, ["serve", "--control-fd=3", join(outdir, `${name}.capnp`)], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise(resolveExit => child.once("close", resolveExit));
      const control = createInterface({ input: child.stdio[3] });
      let timeout;
      try {
        await new Promise((resolveReady, rejectReady) => {
          timeout = setTimeout(() => rejectReady(new Error(`workerd did not initialize within 120s:\n${stderr}`)), 120_000);
          child.once("error", rejectReady);
          child.once("exit", code => rejectReady(new Error(`workerd exited with ${code}:\n${stderr}`)));
          control.on("line", (line) => {
            try {
              const event = JSON.parse(line);
              if (event.event === "listen" && event.socket === "http") resolveReady();
            }
            catch (error) {
              rejectReady(error);
            }
          });
        });
        times[name].push(performance.now() - started);
        memory[name].push(workerdPeak(child.pid));
      }
      finally {
        clearTimeout(timeout);
        control.close();
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
  const net = times.worker.map((time, index) => time - times.empty[index]);
  const peak = values => values.includes(null) ? null : Math.max(...values);
  return {
    emptyReadyMs: summary(times.empty),
    workerReadyMs: summary(times.worker),
    netMs: summary(net),
    // Peak RSS of a workerd that loaded the Worker and served nothing, minus
    // the same for the empty Worker: what the loaded bundle holds in memory.
    netPeakBytes: peak(memory.worker) === null ? null : peak(memory.worker) - peak(memory.empty),
  };
}

function portIsFree(port) {
  return new Promise((resolvePort) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolvePort(false); });
    socket.once("error", () => resolvePort(true));
  });
}

function children(pid) {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid ? [Number(name)] : [];
    }
    catch {
      return [];
    }
  });
}

/** Peak resident memory of every workerd process under `pid`, in bytes. Linux only. */
function workerdPeak(pid) {
  if (process.platform !== "linux") return null;
  let peak = 0;
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift();
    queue.push(...children(current));
    try {
      if (readFileSync(`/proc/${current}/comm`, "utf8").trim() !== "workerd") continue;
      const hwm = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${current}/status`, "utf8"));
      if (hwm) peak = Math.max(peak, Number(hwm[1]) * 1024);
    }
    catch {}
  }
  return peak || null;
}

async function startDev(server, port, state) {
  if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use. Pass --port with a free port.`);
  const started = performance.now();
  const child = spawn(process.execPath, [wranglerBin, "dev", "--config", join(server, "wrangler.json"), "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--log-level", "error", "--show-interactive-dev-session=false"], { env: quietEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 120_000;
  // robots.txt is served from assets without the Worker, so polling it does
  // not warm the Worker before the first measured request.
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}:\n${stderr}`);
    const ready = await fetch(`http://127.0.0.1:${port}/robots.txt`).then(response => response.arrayBuffer().then(() => response.ok), () => false);
    if (ready) return { child, readyMs: performance.now() - started };
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  await stopDev(child, port);
  throw new Error(`wrangler dev was not ready on port ${port} after 120 s:\n${stderr}`);
}

async function stopDev(child, port) {
  if (child.exitCode === null) {
    const exited = new Promise(resolveExit => child.once("exit", resolveExit));
    process.kill(-child.pid, "SIGTERM");
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  for (let attempt = 0; attempt < 50 && !(await portIsFree(port)); attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  if (!(await portIsFree(port))) throw new Error(`Port ${port} is still in use after wrangler dev stopped.`);
}

async function request(port, path) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", headers: { accept: path.includes(".") ? "*/*" : "text/html" } });
  const body = await response.arrayBuffer();
  return { ms: performance.now() - started, status: response.status, bytes: body.byteLength };
}

async function requests(server, flags) {
  const state = mkdtempSync(join(tmpdir(), "docs-worker-bench-"));
  const perPage = Object.fromEntries(pages.map(path => [path, { cold: [], warm: [], status: new Set(), bytes: 0 }]));
  const record = (path, result, phase) => {
    perPage[path][phase].push(result.ms);
    perPage[path].status.add(result.status);
    perPage[path].bytes = result.bytes;
  };
  const devReady = [];
  const firstRequest = [];
  const memory = [];
  try {
    // Cold: a fresh process per sample, and the first request for each page in
    // it. The order rotates so the first request of a process is a different
    // page each time.
    for (let sample = 0; sample < flags.cold; sample++) {
      const { child, readyMs } = await startDev(server, flags.port, state);
      try {
        devReady.push(readyMs);
        const order = pages.map((_, index) => pages[(index + sample * 7) % pages.length]);
        for (const [index, path] of order.entries()) {
          const result = await request(flags.port, path);
          if (index === 0) firstRequest.push(result.ms);
          record(path, result, "cold");
        }
        memory.push(workerdPeak(child.pid));
      }
      finally {
        await stopDev(child, flags.port);
      }
    }
    // Warm: one process, warmup rounds that are not recorded, then fixed rounds.
    const { child } = await startDev(server, flags.port, state);
    try {
      for (let round = 0; round < flags.warmup; round++) for (const path of pages) await request(flags.port, path);
      for (let round = 0; round < flags.warm; round++) for (const path of pages) record(path, await request(flags.port, path), "warm");
      memory.push(workerdPeak(child.pid));
    }
    finally {
      await stopDev(child, flags.port);
    }
  }
  finally {
    rmSync(state, { recursive: true, force: true });
  }
  const all = phase => Object.values(perPage).flatMap(page => page[phase]);
  return {
    devReadyMs: summary(devReady),
    firstRequestMs: summary(firstRequest),
    coldMs: summary(all("cold")),
    warmMs: summary(all("warm")),
    workerdPeakBytes: memory.every(value => value === null) ? null : Math.max(...memory),
    pages: Object.fromEntries(Object.entries(perPage).map(([path, page]) => [path, { status: [...page.status], bytes: page.bytes, cold: summary(page.cold), warm: summary(page.warm) }])),
  };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function run(flags) {
  const server = resolve(flags.server);
  if (!existsSync(join(server, "wrangler.json"))) throw new Error(`No wrangler.json in ${server}. Build the docs first.`);
  const outdir = mkdtempSync(join(tmpdir(), "docs-worker-bundle-"));
  try {
    const loadBefore = loadavg()[0];
    const result = {
      meta: {
        commit: git(["rev-parse", "HEAD"]),
        date: new Date().toISOString(),
        node: process.version,
        wrangler: JSON.parse(readFileSync(wranglerPackage, "utf8")).version,
        cpus: cpus().length,
        pages: pages.length,
        flags: { startup: flags.startup, cold: flags.cold, warmup: flags.warmup, warm: flags.warm },
        load1: [round(loadBefore)],
      },
      bundle: bundle(server, outdir),
      startup: await startup(server, outdir, flags.startup, flags.port),
      ...(await requests(server, flags)),
    };
    result.meta.load1.push(round(loadavg()[0]));
    return result;
  }
  finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const mib = bytes => bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const ms = value => value === null ? "n/a" : `${value} ms`;

function rows(result) {
  return [
    ["Worker bundle", mib(result.bundle.bytes)],
    ["Worker bundle gzip", mib(result.bundle.gzip)],
    ["Start (net of empty Worker) p50", ms(result.startup.netMs.p50)],
    ["workerd ready p50 / empty", `${ms(result.startup.workerReadyMs.p50)} / ${ms(result.startup.emptyReadyMs.p50)}`],
    ["First request after start p50", ms(result.firstRequestMs.p50)],
    ["Cold p50 / p95", `${ms(result.coldMs.p50)} / ${ms(result.coldMs.p95)}`],
    ["Warm p50 / p95", `${ms(result.warmMs.p50)} / ${ms(result.warmMs.p95)}`],
    ["Loaded Worker RSS (net of empty)", mib(result.startup.netPeakBytes)],
    ["wrangler dev workerd peak RSS", mib(result.workerdPeakBytes)],
  ];
}

function printTable(result) {
  for (const [label, value] of rows(result)) console.log(`${label.padEnd(34)} ${value}`);
  const failed = Object.entries(result.pages).filter(([path, page]) => page.status.some(status => status !== (path === "/docs/no-such-page" ? 404 : 200)));
  for (const [path, page] of failed) console.log(`warning: ${path} answered ${page.status.join(", ")}, so it measures a different page than the base did`);
  console.log(`load average (1 min) before / after: ${result.meta.load1.join(" / ")} on ${result.meta.cpus} CPUs`);
}

function compare(basePath, branchPath) {
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const branch = JSON.parse(readFileSync(branchPath, "utf8"));
  const metrics = [
    ["Worker bundle bytes", r => r.bundle.bytes],
    ["Worker bundle gzip", r => r.bundle.gzip],
    ["Start p50", r => r.startup.netMs.p50],
    ["First request p50", r => r.firstRequestMs.p50],
    ["Cold p50", r => r.coldMs.p50],
    ["Cold p95", r => r.coldMs.p95],
    ["Warm p50", r => r.warmMs.p50],
    ["Warm p95", r => r.warmMs.p95],
    ["Loaded Worker RSS", r => r.startup.netPeakBytes],
    ["Dev workerd peak RSS", r => r.workerdPeakBytes],
  ];
  console.log(`${"".padEnd(22)} ${"base".padStart(14)} ${"branch".padStart(14)} ${"ratio".padStart(7)}`);
  for (const [label, read] of metrics) {
    const a = read(base);
    const b = read(branch);
    const ratio = a && b !== null ? (b / a).toFixed(2) : "n/a";
    console.log(`${label.padEnd(22)} ${String(a).padStart(14)} ${String(b).padStart(14)} ${ratio.padStart(7)}`);
  }
  let regressed = false;
  if (base.coldMs.p95 && branch.coldMs.p95 / base.coldMs.p95 > coldRegression) {
    regressed = true;
    console.log(`REGRESSION: cold p95 is ${(branch.coldMs.p95 / base.coldMs.p95).toFixed(2)}x the base (limit ${coldRegression}x).`);
    console.log("Machine load moves cold p95. Run both sides again before you trust this, and check the per-page lines below.");
  }
  for (const path of pages) {
    const a = base.pages[path]?.cold.p95;
    const b = branch.pages[path]?.cold.p95;
    if (a && b && b / a > coldRegression) console.log(`page ${path}: cold p95 ${a} ms -> ${b} ms (${(b / a).toFixed(2)}x)`);
  }
  return regressed ? 1 : 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "compare" && rest.length === 2) {
    process.exitCode = compare(rest[0], rest[1]);
  }
  else if (command === "run") {
    const flags = parseFlags(rest);
    const result = await run(flags);
    if (flags.out) {
      mkdirSync(dirname(resolve(flags.out)), { recursive: true });
      writeFileSync(flags.out, `${JSON.stringify(result, null, 2)}\n`);
    }
    else console.log(JSON.stringify(result, null, 2));
    printTable(result);
  }
  else {
    console.error("Usage:\n  node docs/scripts/bench-worker.mjs run [--server docs/.output/server] [--out result.json] [--port 4813] [--startup 10] [--cold 10] [--warmup 2] [--warm 10]\n  node docs/scripts/bench-worker.mjs compare base.json branch.json");
    process.exitCode = 2;
  }
}

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/bench-worker.mjs", import.meta.url));
const directories: string[] = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "docs-worker-bench-test-"));
  directories.push(path);
  return path;
}

function bench(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
}

function result(coldP95: number) {
  const timing = { n: 1, p50: 10, p95: coldP95, min: 10, max: coldP95 };
  return {
    bundle: { bytes: 100, gzip: 50 },
    startup: { netMs: timing, netPeakBytes: 1 },
    firstRequestMs: timing,
    coldMs: timing,
    warmMs: timing,
    workerdPeakBytes: 1,
    pages: { "/": { status: [200], bytes: 1, cold: timing, warm: timing } },
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("docs Worker bench", () => {
  it("fails a comparison only when cold p95 grows more than 1.5 times", () => {
    const root = directory();
    writeFileSync(join(root, "base.json"), JSON.stringify(result(100)));
    writeFileSync(join(root, "same.json"), JSON.stringify(result(150)));
    writeFileSync(join(root, "slow.json"), JSON.stringify(result(151)));

    const same = bench("compare", join(root, "base.json"), join(root, "same.json"));
    expect(same.status, same.stdout + same.stderr).toBe(0);
    const slow = bench("compare", join(root, "base.json"), join(root, "slow.json"));
    expect(slow.status).toBe(1);
    expect(slow.stdout).toContain("REGRESSION: cold p95 is 1.51x");
    expect(slow.stdout).toContain("page /: cold p95 100 ms -> 151 ms");
  });

  it("measures a split Worker with Wrangler and workerd", () => {
    const root = directory();
    const server = join(root, ".output/server");
    mkdirSync(join(root, ".output/public"), { recursive: true });
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, ".output/public/robots.txt"), "User-agent: *\n");
    const imports = Array.from({ length: 32 }, (_, index) => {
      writeFileSync(join(server, `${index}.txt`), `module ${index}: ${"shared content ".repeat(100)}`);
      return `import text${index} from './${index}.txt';`;
    });
    writeFileSync(join(server, "index.mjs"), `${imports.join("\n")}\nexport default { fetch() { return new Response([${imports.map((_, index) => `text${index}`).join(",")}].join('')) } };\n`);
    writeFileSync(join(server, "wrangler.json"), JSON.stringify({ name: "bench-test", main: "index.mjs", compatibility_date: "2026-07-19", assets: { directory: "../public", binding: "ASSETS" } }));

    const run = bench("run", "--server", server, "--out", join(root, "result.json"), "--port", "4817", "--startup", "1", "--cold", "1", "--warmup", "0", "--warm", "1");
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const output = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(output.bundle.bytes).toBeGreaterThan(0);
    expect(output.bundle.modules.length).toBe(33);
    expect(output.bundle.gzip / 1024).toBeCloseTo(output.bundle.wranglerGzipKiB, 2);
    expect(output.bundle.assets.files).toBe(1);
    expect(output.startup.workerReadyMs.n).toBe(1);
    expect(output.coldMs.n).toBe(20);
    expect(output.warmMs.n).toBe(20);
    expect(output.pages["/llms.txt"].status).toEqual([200]);
    expect(run.stdout).toContain("Cold p50 / p95");
  }, 120_000);

  it("includes top-level execution and allocation in startup without sending a request", () => {
    const root = directory();
    const server = join(root, ".output/server");
    mkdirSync(join(root, ".output/public"), { recursive: true });
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, ".output/public/robots.txt"), "User-agent: *\n");
    writeFileSync(join(server, "index.mjs"), `
      const memory = new Uint8Array(100 * 1024 * 1024).fill(1);
      let sum = 0;
      for (let index = 0; index < 500_000_000; index++) sum += Math.sqrt(index);
      export default { fetch() { throw new Error('Unexpected request: ' + sum + memory[0]) } };
    `);
    writeFileSync(join(server, "wrangler.json"), JSON.stringify({ name: "bench-startup-test", main: "index.mjs", compatibility_date: "2026-07-19", assets: { directory: "../public", binding: "ASSETS" } }));

    const run = bench("run", "--server", server, "--out", join(root, "result.json"), "--port", "4818", "--startup", "2", "--cold", "0", "--warmup", "0", "--warm", "0");
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const output = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect.soft(output.startup.netMs.min).toBeGreaterThan(500);
    if (process.platform === "linux") expect.soft(output.startup.netPeakBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(output.coldMs.n).toBe(0);
    expect(output.warmMs.n).toBe(0);
  }, 120_000);
});

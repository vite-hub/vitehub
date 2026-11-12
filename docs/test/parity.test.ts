import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/parity.mjs", import.meta.url));
const directories: string[] = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "docs-parity-test-"));
  directories.push(path);
  return path;
}

// Exercise the CLI with deterministic HTTP and MCP responses, without a docs build or retry delays.
const preload = `
const scenario = process.env.PARITY_SCENARIO;
const delay = globalThis.setTimeout;
globalThis.setTimeout = (callback, _ms, ...args) => delay(callback, 0, ...args);
let attempts = 0;
globalThis.fetch = async (input, init) => {
  const path = new URL(input).pathname;
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fail = () => {
    console.error("transport failure");
    throw new Error("ECONNRESET");
  };
  if (path === "/mcp") {
    const { id, method, params } = JSON.parse(init.body);
    if (scenario === "initialize" && method === "initialize") fail();
    if (scenario === "list-pages" && params?.name === "list-pages") fail();
    if (scenario === "get-page" && params?.name === "get-page" && params.arguments.path === "/docs/kv") fail();
    if (method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    const content = params.name === "list-pages" ? [{ path: "/docs/kv" }, { path: "/docs/last" }] : { title: "Page" };
    return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(content) }] } });
  }
  if (path === "/sitemap.xml") return new Response(
    '<urlset><url><loc>https://docs.test/docs/kv</loc></url><url><loc>https://docs.test/docs/last</loc></url></urlset>',
    { headers: { "content-type": "application/xml" } },
  );
  if (path === "/api/_docs/search.json") return json([]);
  if ((path === "/docs/kv" || path === "/docs/last") && init.headers.accept !== "text/markdown") {
    if (path === "/docs/kv") attempts++;
    if (path === "/docs/kv" && (scenario === "fetch" || (scenario === "transient" && attempts < 3))) fail();
    const text = scenario === "limit" && path === "/docs/kv" ? "Before" : process.env.PARITY_TEXT;
    return new Response('<html><head><title>KV</title></head><body><h1>' + text + '</h1></body></html>', {
      headers: { "content-type": "text/html" },
    });
  }
  return new Response("Resource", { status: path.includes("missing-page") ? 404 : 200, headers: { "content-type": "text/plain" } });
};
`;

function parity(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
}

function crawl(root: string, name: string, scenario = "ok", limit = 20_000, text = "Before") {
  const mock = join(root, "fetch.mjs");
  writeFileSync(mock, preload);
  const out = join(root, name);
  const result = spawnSync(process.execPath, ["--import", mock, script, "crawl", "https://docs.test", out, "--limit", String(limit)], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PARITY_SCENARIO: scenario, PARITY_TEXT: text },
  });
  const snapshot = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8")) as {
    complete?: boolean;
    failures: number;
    truncated: boolean;
    entries: Record<string, { status: number; type: string }>;
  };
  return { out, result, snapshot };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("docs site parity", () => {
  it("compares complete snapshots, including fetched 404s, and detects visible text changes", () => {
    const root = directory();
    const before = crawl(root, "before");
    const same = crawl(root, "same");
    expect(before.result.status, before.result.stdout + before.result.stderr).toBe(0);
    expect(before.snapshot.complete).toBe(true);
    expect(before.snapshot.entries["GET /__parity__/missing-page"].status).toBe(404);
    expect(before.snapshot.entries["GET /__parity__/missing-page [accept markdown]"].status).toBe(404);
    expect(parity("compare", before.out, same.out).status).toBe(0);

    const changed = crawl(root, "changed", "ok", 20_000, "After");
    const comparison = parity("compare", before.out, changed.out);
    expect(comparison.status).toBe(1);
    expect(comparison.stdout).toContain("~ GET /docs/kv");
    expect(comparison.stdout).toContain("Before");
    expect(comparison.stdout).toContain("After");
  });

  it.each(["fetch", "get-page", "initialize", "list-pages"])("rejects matching incomplete snapshots after %s transport failures", (scenario) => {
    const root = directory();
    const before = crawl(root, "before", scenario);
    const after = crawl(root, "after", scenario);
    for (const run of [before, after]) {
      expect(run.result.status, run.result.stdout + run.result.stderr).toBe(1);
      expect(run.snapshot.complete).toBe(false);
      expect(run.snapshot.failures).toBe(1);
      expect(run.result.stderr).toContain("Incomplete crawl");
    }
    const comparison = parity("compare", before.out, after.out);
    expect(comparison.status).toBe(1);
    expect(comparison.stderr).toContain("Incomplete snapshot");
  });

  it("rejects matching truncated snapshots and applies the limit to GET and MCP page requests", () => {
    const root = directory();
    const before = crawl(root, "before", "limit", 7);
    const after = crawl(root, "after", "limit", 7, "After");
    for (const run of [before, after]) {
      expect(run.result.status, run.result.stdout + run.result.stderr).toBe(1);
      expect(run.snapshot.complete).toBe(false);
      expect(run.snapshot.truncated).toBe(true);
      expect(run.snapshot.failures).toBe(0);
      // MCP list-pages is a discovery request outside the bounded page queue.
      expect(Object.keys(run.snapshot.entries).length).toBeLessThanOrEqual(8);
      expect(run.snapshot.entries["GET /docs/last"]).toBeUndefined();
    }
    const comparison = parity("compare", before.out, after.out);
    expect(comparison.status).toBe(1);
    expect(comparison.stderr).toContain("Incomplete snapshot");
  });

  it("allows a complete crawl after transient transport failures recover", () => {
    const run = crawl(directory(), "recovered", "transient");
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(run.snapshot.complete).toBe(true);
    expect(run.snapshot.failures).toBe(0);
    expect(run.result.stderr.match(/transport failure/g)).toHaveLength(2);
  });

  it("rejects snapshots that predate completeness tracking", () => {
    const run = crawl(directory(), "legacy");
    delete run.snapshot.complete;
    writeFileSync(join(run.out, "snapshot.json"), JSON.stringify(run.snapshot));
    const comparison = parity("compare", run.out, run.out);
    expect(comparison.status).toBe(1);
    expect(comparison.stderr).toContain("Incomplete snapshot");
  });
});

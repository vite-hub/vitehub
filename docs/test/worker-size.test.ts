import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { array, object, optional, parse, string } from "valibot";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { checkWorkerSize } from "../scripts/check-worker-size.mjs";

const directories: string[] = [];

function bundle() {
  const directory = mkdtempSync(join(tmpdir(), "docs-worker-size-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("docs Worker upload budget", () => {
  it("checks the bundle emitted by the workflow with a nested Wrangler config", () => {
    const directory = bundle();
    const root = new URL("../../", import.meta.url);
    const server = join(directory, "docs/.output/server");
    mkdirSync(server, { recursive: true });
    mkdirSync(join(directory, "docs/scripts"), { recursive: true });
    symlinkSync(fileURLToPath(new URL("node_modules", root)), join(directory, "node_modules"), "dir");
    copyFileSync(new URL("docs/scripts/check-worker-size.mjs", root), join(directory, "docs/scripts/check-worker-size.mjs"));
    writeFileSync(join(server, "index.js"), "export default { fetch() { return new Response('ok') } };\n");
    writeFileSync(join(server, "wrangler.json"), JSON.stringify({ name: "worker-size-test", main: "index.js", compatibility_date: "2026-07-19" }));
    const workflow = parse(object({ jobs: object({ docs: object({ steps: array(object({ name: optional(string()), run: optional(string()) })) }) }) }),
      parseYaml(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8")));
    const command = workflow.jobs.docs.steps.find(step => step.name === "Verify Worker bundle")?.run;
    if (!command) throw new Error("The docs workflow must verify the Worker bundle.");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", command], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GITHUB_WORKSPACE: directory, WRANGLER_SEND_METRICS: "false", XDG_CONFIG_HOME: directory },
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Docs Worker:");
    expect(checkWorkerSize(join(directory, "docs/.wrangler/bundle")).bytes).toBeGreaterThan(0);
  }, 30_000);

  it("counts bytes of the entry point and nested text, JSON and Wasm modules", () => {
    const directory = bundle();
    mkdirSync(join(directory, "chunks"));
    writeFileSync(join(directory, "index.js"), "export default {};");
    writeFileSync(join(directory, "chunks", "page.txt"), "café");
    writeFileSync(join(directory, "chunks", "data.json"), "{}");
    writeFileSync(join(directory, "chunks", "engine.wasm"), new Uint8Array([0, 97, 115, 109]));
    writeFileSync(join(directory, "README.md"), "Not uploaded");
    writeFileSync(join(directory, "index.js.map"), "Not a Worker module");

    expect(checkWorkerSize(directory)).toEqual({ bytes: 29, modules: 4 });
  });

  it("rejects an aggregate upload above 60 MiB even when each module is smaller", () => {
    const directory = bundle();
    const entry = join(directory, "index.js");
    writeFileSync(entry, "");
    truncateSync(entry, 60 * 1024 * 1024);
    expect(checkWorkerSize(directory).bytes).toBe(60 * 1024 * 1024);
    writeFileSync(join(directory, "engine.wasm"), new Uint8Array([0]));

    expect(() => checkWorkerSize(directory)).toThrow("exceeding the 60 MiB budget");
  });

  it("rejects more modules than the budget, far below Cloudflare's 5,000", () => {
    const directory = bundle();
    mkdirSync(join(directory, "_virtual"));
    writeFileSync(join(directory, "index.js"), "export default {};");
    for (let index = 1; index < 2500; index++) writeFileSync(join(directory, "_virtual", `page${index}.md.mjs`), "export default ``");
    expect(checkWorkerSize(directory).modules).toBe(2500);
    writeFileSync(join(directory, "_virtual", "one-more.md.mjs"), "export default ``");

    expect(() => checkWorkerSize(directory)).toThrow("2501 modules, exceeding the budget of 2500");
  });

  it("rejects missing build output rather than reporting a zero-byte upload", () => {
    const directory = bundle();
    writeFileSync(join(directory, "README.md"), "Not uploaded");
    expect(() => checkWorkerSize(directory)).toThrow("No Worker modules found");
    expect(() => checkWorkerSize(join(directory, "missing"))).toThrow();
  });
});

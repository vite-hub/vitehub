import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("counts bytes of the entry point and nested text, JSON and Wasm modules", () => {
    const directory = bundle();
    mkdirSync(join(directory, "chunks"));
    writeFileSync(join(directory, "index.js"), "export default {};");
    writeFileSync(join(directory, "chunks", "page.txt"), "café");
    writeFileSync(join(directory, "chunks", "data.json"), "{}");
    writeFileSync(join(directory, "chunks", "engine.wasm"), new Uint8Array([0, 97, 115, 109]));
    writeFileSync(join(directory, "README.md"), "Not uploaded");
    writeFileSync(join(directory, "index.js.map"), "Not a Worker module");

    expect(checkWorkerSize(directory)).toBe(29);
  });

  it("rejects an aggregate upload above 60 MiB even when each module is smaller", () => {
    const directory = bundle();
    const entry = join(directory, "index.js");
    writeFileSync(entry, "");
    truncateSync(entry, 60 * 1024 * 1024);
    expect(checkWorkerSize(directory)).toBe(60 * 1024 * 1024);
    writeFileSync(join(directory, "engine.wasm"), new Uint8Array([0]));

    expect(() => checkWorkerSize(directory)).toThrow("exceeding the 60 MiB budget");
  });

  it("rejects missing build output rather than reporting a zero-byte upload", () => {
    const directory = bundle();
    writeFileSync(join(directory, "README.md"), "Not uploaded");
    expect(() => checkWorkerSize(directory)).toThrow("No Worker modules found");
    expect(() => checkWorkerSize(join(directory, "missing"))).toThrow();
  });
});

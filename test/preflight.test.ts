import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const preflight = resolve(import.meta.dirname, "preflight.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fakeDeno(version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-preflight-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, process.platform === "win32" ? "deno.cmd" : "deno");
  const contents = process.platform === "win32"
    ? `@echo deno ${version}`
    : `#!/bin/sh\nprintf 'deno ${version}\\n'`;
  await writeFile(executable, contents);
  await chmod(executable, 0o755);
  return directory;
}

function runPreflight(path: string) {
  return spawnSync(process.execPath, [preflight], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path,
    },
  });
}

describe("contributor preflight", () => {
  it("accepts the pinned Deno version through the real entrypoint", async () => {
    const directory = await fakeDeno("2.9.3");

    const result = runPreflight(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Contributor prerequisites are ready. Deno 2.9.3.\n");
    expect(result.stderr).toBe("");
  });

  it("explains when Deno is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-preflight-empty-"));
    temporaryDirectories.push(directory);

    const result = runPreflight(directory);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Deno 2.9.3 is required");
    expect(result.stderr).toContain("deno was not found on PATH");
  });

  it("reports a different Deno version", async () => {
    const directory = await fakeDeno("2.8.5");

    const result = runPreflight(`${directory}${delimiter}${process.env.PATH || ""}`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Deno 2.9.3 is required");
    expect(result.stderr).toContain("found 2.8.5");
  });
});

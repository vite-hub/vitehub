import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");

it("schedules the docs dependency graph without an Agent/Env cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-env-graph-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const entries = await readdir(join(repoRoot, "packages"), { withFileTypes: true });
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      const manifest = JSON.parse(await readFile(join(repoRoot, "packages", entry.name, "package.json"), "utf8"));
      // Keep the real dependency graph, but execute no builds or install scripts.
      manifest.scripts = { "identity-graph-check": 'node -e ""' };
      const dir = join(root, "packages", entry.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    }
    // A versioned optional peer supplies the verifier at runtime without making
    // Agent a workspace build prerequisite of Env (Agent already depends on Env).
    const { stderr } = await execFileAsync(process.execPath, [
      fileURLToPath(import.meta.resolve("vite-plus/bin")),
      "run", "--filter", "@vite-hub/agent...", "--filter", "@vite-hub/ui...", "identity-graph-check",
    ], { cwd: root, timeout: 20_000 });
    expect(stderr).not.toContain("Cycle dependency detected");
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

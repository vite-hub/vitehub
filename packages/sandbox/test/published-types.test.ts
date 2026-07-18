import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(packageRoot, "fixtures", "published-types");
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc");

it("publishes the Sandbox and error contract to an installed consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-types-"));

  try {
    await cp(fixtureRoot, root, { recursive: true });
    await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true });
    await symlink(
      join(workspaceRoot, "node_modules", "@types"),
      join(root, "node_modules", "@types"),
      "dir",
    );

    for (const name of ["runtime", "sandbox"]) {
      const source = join(workspaceRoot, "packages", name);
      const installed = join(root, "node_modules", "@vite-hub", name);
      await mkdir(installed, { recursive: true });
      await copyFile(join(source, "package.json"), join(installed, "package.json"));
      await cp(join(source, "dist"), join(installed, "dist"), { recursive: true });
    }

    try {
      await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root]);
    } catch (error) {
      const result = error as Error & { stderr?: string; stdout?: string };
      throw new Error([result.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

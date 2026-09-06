import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const toolVersions = readFileSync(resolve(import.meta.dirname, "../.tool-versions"), "utf8");
export const requiredDenoVersion = /^deno\s+(\S+)$/m.exec(toolVersions)?.[1];

if (!requiredDenoVersion) {
  throw new Error(".tool-versions must declare the required Deno version");
}

export function checkDeno({ env = process.env } = {}) {
  const result = spawnSync("deno", ["--version"], {
    encoding: "utf8",
    env,
  });

  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      message: `Deno ${requiredDenoVersion} is required to run the full verification gate, but deno was not found on PATH. Install Deno ${requiredDenoVersion}, then run vp run preflight again.`,
    };
  }

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `deno --version exited with status ${result.status}`;
    return {
      ok: false,
      message: `Could not check Deno: ${detail}`,
    };
  }

  const installedVersion = /^deno (\S+)/m.exec(result.stdout)?.[1];
  if (installedVersion !== requiredDenoVersion) {
    return {
      ok: false,
      message: `Deno ${requiredDenoVersion} is required to run the full verification gate, but found ${installedVersion || "an unknown version"}. Install Deno ${requiredDenoVersion}, then run vp run preflight again.`,
    };
  }

  return { ok: true };
}

function main() {
  const result = checkDeno();
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(`Contributor prerequisites are ready. Deno ${requiredDenoVersion}.`);
}

if (process.argv[1] === import.meta.filename) {
  main();
}

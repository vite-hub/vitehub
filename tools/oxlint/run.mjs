import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const baselineUrl = new URL("./anti-slop-baseline.json", import.meta.url);
const vitePlusBin = fileURLToPath(new URL("../../node_modules/vite-plus/bin/vp", import.meta.url));
const result = spawnSync(process.execPath, [vitePlusBin, "lint", "--format", "json"], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});

if (result.error) throw result.error;

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const antiSlopDiagnostics = report.diagnostics.filter((diagnostic) =>
  diagnostic.code.startsWith("anti-slop("),
);
const identity = (diagnostic) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        code: diagnostic.code,
        filename: diagnostic.filename,
        labels: diagnostic.labels,
        message: diagnostic.message,
      }),
    )
    .digest("hex");

if (process.argv.includes("--update-baseline")) {
  const hashes = antiSlopDiagnostics.map(identity).sort();
  await writeFile(baselineUrl, `${JSON.stringify({ version: 1, hashes }, null, 2)}\n`);
  console.log(`Saved ${hashes.length} anti-slop diagnostics to the baseline.`);
  process.exit(result.status ?? 0);
}

const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
if (baseline.version !== 1 || !Array.isArray(baseline.hashes)) {
  throw new Error("Unsupported anti-slop baseline format.");
}

const remaining = new Map();
for (const hash of baseline.hashes) {
  remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
}
const newDiagnostics = antiSlopDiagnostics.filter((diagnostic) => {
  const hash = identity(diagnostic);
  const count = remaining.get(hash) ?? 0;
  if (count === 0) return true;
  remaining.set(hash, count - 1);
  return false;
});

if (newDiagnostics.length > 0) {
  console.error(`${newDiagnostics.length} new anti-slop diagnostic(s):`);
  for (const diagnostic of newDiagnostics) {
    const label = diagnostic.labels[0]?.span;
    const location = label
      ? `${diagnostic.filename}:${label.line}:${label.column}`
      : diagnostic.filename;
    console.error(`${location} ${diagnostic.code}: ${diagnostic.message}`);
  }
}

const resolvedCount = [...remaining.values()].reduce((total, count) => total + count, 0);
console.log(
  `Anti-slop: ${antiSlopDiagnostics.length} current, ${resolvedCount} resolved from baseline, ${newDiagnostics.length} new.`,
);

process.exit(result.status !== 0 || newDiagnostics.length > 0 ? 1 : 0);

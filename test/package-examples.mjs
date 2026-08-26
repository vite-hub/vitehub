#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "test", "package-examples.json");
const generatedRoots = [".netlify", ".vercel", ".vitehub", "dist"];

export function loadExampleContracts(path = manifestPath) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest.examples)) throw new TypeError("test/package-examples.json must contain an examples array.");
  return manifest.examples;
}

export function discoverPackageExamples(root = repoRoot) {
  const discovered = [];
  const packagesDir = join(root, "packages");
  for (const packageEntry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    const showcasePath = join(packagesDir, packageEntry.name, "examples", "showcase.json");
    if (!existsSync(showcasePath)) continue;
    const showcase = JSON.parse(readFileSync(showcasePath, "utf8"));
    for (const framework of Object.keys(showcase.frameworks ?? {})) {
      discovered.push(`${packageEntry.name}:${framework}`);
    }
  }
  return discovered.sort();
}

export function assertManifestCompleteness(contracts, root = repoRoot) {
  const keys = contracts.map(contract => `${contract.id}:${contract.framework}`);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate package example contracts: ${[...new Set(duplicates)].join(", ")}`);

  const discovered = discoverPackageExamples(root);
  const missing = discovered.filter(key => !keys.includes(key));
  const unknown = keys.filter(key => !discovered.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Package example manifest mismatch. Missing: ${missing.join(", ") || "none"}. Unknown: ${unknown.join(", ") || "none"}.`);
  }

  for (const contract of contracts) {
    if (!(["provider-output", "server-bundle"].includes(contract.artifact))) {
      throw new Error(`${contract.id}:${contract.framework} has unknown artifact ${JSON.stringify(contract.artifact)}.`);
    }
    if (!Array.isArray(contract.outputs) || contract.outputs.length === 0) {
      throw new Error(`${contract.id}:${contract.framework} must declare at least one output.`);
    }
    for (const output of contract.outputs) assertRelativePath(output, `${contract.id}:${contract.framework} output`);

    const packageDir = join(root, "packages", contract.id);
    const exampleDir = join(packageDir, "examples", contract.framework);
    const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const exampleManifest = JSON.parse(readFileSync(join(exampleDir, "package.json"), "utf8"));
    if (!exampleManifest.name || exampleManifest.private !== true || exampleManifest.scripts?.build !== "vp build") {
      throw new Error(`${contract.id}:${contract.framework} must be a named private package with a Vite+ build script.`);
    }
    if (exampleManifest.dependencies?.[packageManifest.name] !== "workspace:*") {
      throw new Error(`${contract.id}:${contract.framework} must consume ${packageManifest.name} through workspace:*.`);
    }
  }
}

export function cleanExampleOutput(exampleDir) {
  for (const path of generatedRoots) rmSync(join(exampleDir, path), { force: true, recursive: true });
}

export function assertExampleOutputs(contract, exampleDir) {
  for (const output of contract.outputs) {
    const outputPath = join(exampleDir, output);
    const outputStat = existsSync(outputPath) ? statSync(outputPath) : undefined;
    if (!outputStat?.isFile() || outputStat.size === 0) {
      throw new Error(`${contract.id}:${contract.framework} did not emit ${output}.`);
    }
    if (output.endsWith(".json")) JSON.parse(readFileSync(outputPath, "utf8"));
  }
}

export function runPackageExamples(contracts = loadExampleContracts(), root = repoRoot) {
  assertManifestCompleteness(contracts, root);
  for (const contract of contracts) {
    const packageDir = join(root, "packages", contract.id);
    const exampleDir = join(packageDir, "examples", contract.framework);
    if (!existsSync(join(packageDir, "dist"))) {
      throw new Error(`Build the workspace packages before ${contract.id}:${contract.framework}.`);
    }
    cleanExampleOutput(exampleDir);
    process.stdout.write(`[examples] ${contract.id}:${contract.framework} (${contract.artifact})\n`);
    const result = spawnSync("corepack", ["pnpm", "--dir", exampleDir, "run", "build"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${contract.id}:${contract.framework} build exited with status ${result.status ?? "unknown"}.`);
    assertExampleOutputs(contract, exampleDir);
  }
  process.stdout.write(`Verified ${contracts.length} package example contracts.\n`);
}

function assertRelativePath(path, label) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.split(sep).includes("..")) {
    throw new Error(`${label} must be a relative path inside its example.`);
  }
}

if (import.meta.main) runPackageExamples();

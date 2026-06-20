#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const task = process.argv[2];

if (!task) {
  console.error("Usage: node test/run-package-task.mjs <task>");
  process.exit(1);
}

const packageDirs = readdirSync("packages", { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join("packages", entry.name));

const packages = packageDirs
  .map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { dir, manifest, name: manifest.name };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const packageByName = new Map(packages.map(pkg => [pkg.name, pkg]));
const visited = new Set();
const visiting = new Set();
const orderedPackages = [];

function workspaceDependencies(manifest) {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
  ]
    .filter(([name, version]) => packageByName.has(name) && String(version).startsWith("workspace:"))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

function visit(pkg) {
  if (visited.has(pkg.name)) {
    return;
  }
  if (visiting.has(pkg.name)) {
    throw new Error(`Circular workspace dependency involving ${pkg.name}`);
  }

  visiting.add(pkg.name);
  for (const dependencyName of workspaceDependencies(pkg.manifest)) {
    visit(packageByName.get(dependencyName));
  }
  visiting.delete(pkg.name);
  visited.add(pkg.name);
  orderedPackages.push(pkg);
}

for (const pkg of packages) {
  visit(pkg);
}

for (const pkg of orderedPackages) {
  if (!pkg.manifest.scripts?.[task]) {
    continue;
  }

  console.log(`\n[${task}] ${pkg.name}`);
  const result = spawnSync("vp", ["run", "--filter", pkg.name, "--ignore-depends-on", task], {
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

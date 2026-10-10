import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import * as v from "valibot";

const dependencies = v.optional(v.record(v.string(), v.string()));
const manifestSchema = v.object({
  name: v.optional(v.string()), dependencies, devDependencies: dependencies,
  optionalDependencies: dependencies, peerDependencies: dependencies,
});

/** Stable across rebuilds, including previews that reuse the manifest version. */
export function agentBuildRevision(root: string): string {
  root = resolve(root);
  let workspace: string | undefined;
  for (let directory = root;; directory = dirname(directory)) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) { workspace = directory; break; }
    if (dirname(directory) === directory) break;
  }
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const visited = new Set<string>();
  const add = (path: string) => { if (existsSync(path)) files.add(path); };
  const manifest = (directory: string) => v.parse(manifestSchema, JSON.parse(readFileSync(join(directory, "package.json"), "utf8")));
  if (workspace) {
    for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "tsconfig.json", "vite.config.ts"]) add(join(workspace, name));
    const directory = join(workspace, "packages");
    if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!entry.isDirectory() || !existsSync(join(path, "package.json"))) continue;
      const name = manifest(path).name;
      if (name) packages.set(name, path);
    }
  }
  const visit = (directory: string) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const name of ["package.json", "vite.config.ts", "tsconfig.json", "tsconfig.build.json"]) add(join(directory, name));
    for (const name of ["src", "build"]) {
      const source = join(directory, name);
      if (!existsSync(source)) continue;
      for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) files.add(join(entry.parentPath, entry.name));
      }
    }
    const input = manifest(directory);
    for (const name of new Set([...Object.keys(input.dependencies ?? {}), ...Object.keys(input.devDependencies ?? {}),
      ...Object.keys(input.optionalDependencies ?? {}), ...Object.keys(input.peerDependencies ?? {})])) {
      const dependency = packages.get(name);
      if (dependency) visit(dependency);
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const contents = readFileSync(path);
    hash.update(JSON.stringify([relative(workspace ?? root, path).replaceAll("\\", "/"), contents.byteLength]));
    hash.update(contents);
  }
  return hash.digest("hex");
}

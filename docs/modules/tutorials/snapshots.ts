import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveManifest } from "./build";

import type { RunnableTutorialSource, WorkspaceVersions } from "./build";

/** The parts of a tutorial's snapshot, for `fetchSnapshot(parts, { sha256 })`. */
export interface TutorialSnapshot {
  parts: string[]
  /** The SHA-256 of the joined parts, in hex. */
  sha256: string
}

/** The snapshot of each tutorial, by slug. */
export type TutorialSnapshots = Record<string, TutorialSnapshot>;

/** `snapshots.json`: the snapshots, and the hash of the inputs that they were built from. */
interface SnapshotsFile {
  inputs: string
  tutorials: TutorialSnapshots
}

/** The npm lockfile that pins the install of each tutorial, in this repository. */
export function tutorialLockfile(locksDir: string, slug: string): string {
  return resolve(locksDir, `${slug}.package-lock.json`);
}

interface Manifest {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"];

/**
 * `pnpm pack` writes the dependencies that had `workspace:` specifiers in a different order on each run. The installed
 * `package.json` would then change the snapshot bytes, so sort those fields and pack the tarball again.
 */
export async function sortPackedManifest(tarball: string, scratch: string): Promise<void> {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", scratch]);
  const path = resolve(scratch, "package/package.json");
  const manifest: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
  for (const field of dependencyFields) {
    const value = manifest[field];
    if (value && typeof value === "object") manifest[field] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("tar", ["-czf", tarball, "-C", scratch, "package"]);
  await rm(scratch, { recursive: true, force: true });
}

/**
 * A hash of everything that decides what a snapshot installs: the fixture manifests, the npm lockfiles of the
 * tutorials, the pnpm catalogs, the workspace lockfile, and the manifest of every workspace package. Source code is not
 * in it: a dev server reuses a snapshot with older package code until `TUTORIAL_SNAPSHOTS=1` rebuilds it.
 */
export async function tutorialSnapshotInputs(input: {
  tutorials: RunnableTutorialSource[]
  repoRoot: string
  fixturesDir: string
  locksDir: string
  versions: WorkspaceVersions
}): Promise<string> {
  const hash = createHash("sha256");
  const add = (label: string, contents: string) => hash.update(`${label}\0${contents}\0`);
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  add("versions", JSON.stringify(input.versions));
  add("pnpm-lock.yaml", await read(resolve(input.repoRoot, "pnpm-lock.yaml")));
  for (const tutorial of input.tutorials) {
    add(`${tutorial.slug} fixture`, await read(resolve(input.fixturesDir, tutorial.fixture, "package.json")));
    add(`${tutorial.slug} lockfile`, await read(tutorialLockfile(input.locksDir, tutorial.slug)));
  }
  for (const entry of (await readdir(resolve(input.repoRoot, "packages"))).sort()) {
    add(`packages/${entry}`, await read(resolve(input.repoRoot, "packages", entry, "package.json")));
  }
  return hash.digest("hex");
}

/**
 * Reads the snapshots of the last build when they were built from `inputs`. Removes them, and returns nothing, when
 * snapshots are disabled.
 */
export async function readTutorialSnapshots(outDir: string, options: { inputs: string, disabled?: boolean }): Promise<TutorialSnapshots | undefined> {
  if (options.disabled) {
    await rm(resolve(outDir, "snapshots"), { recursive: true, force: true });
    await rm(resolve(outDir, "snapshots.json"), { force: true });
    return;
  }
  const file: Partial<SnapshotsFile> | undefined = await readFile(resolve(outDir, "snapshots.json"), "utf8").then(JSON.parse, () => undefined);
  return file?.inputs === options.inputs ? file.tutorials : undefined;
}

/**
 * Builds the `node_modules` snapshot of each tutorial, so its workspace skips `npm install` in the browser.
 *
 * For each tutorial this builds and packs the workspace packages that the fixture uses, so the snapshot holds the code
 * that the docs describe. It installs them with the other dependencies of the fixture through
 * `createNodeModulesSnapshot` in `snapshot-worker.mjs`, pinned by the npm lockfile in `locksDir`, and writes the gzip
 * parts to `<outDir>/snapshots/` with `snapshots.json` beside them.
 */
export async function buildTutorialSnapshots(input: {
  tutorials: RunnableTutorialSource[]
  repoRoot: string
  fixturesDir: string
  versions: WorkspaceVersions
  /** Served at `baseURL`. */
  outDir: string
  baseURL: string
  /** Temporary install folders. */
  workDir: string
  /** The npm lockfiles of the tutorials. A build that resolves new versions writes them here. */
  locksDir: string
}): Promise<TutorialSnapshots> {
  const { repoRoot, outDir, workDir } = input;
  const workspace = new Map<string, { dir: string, manifest: Manifest }>();
  for (const entry of await readdir(resolve(repoRoot, "packages"))) {
    const dir = resolve(repoRoot, "packages", entry);
    const manifest: Manifest | undefined = await readFile(resolve(dir, "package.json"), "utf8").then(JSON.parse, () => undefined);
    if (manifest?.name) workspace.set(manifest.name, { dir, manifest });
  }
  const closure = (names: string[]): string[] => {
    const seen = new Set<string>();
    const visit = (name: string) => {
      const found = workspace.get(name);
      if (!found || found.manifest.private || seen.has(name)) return;
      seen.add(name);
      for (const dependency of Object.keys(found.manifest.dependencies ?? {})) visit(dependency);
    };
    names.forEach(visit);
    return [...seen];
  };
  const run = (command: string, args: string[], cwd = repoRoot) => execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

  const snapshotsDir = resolve(outDir, "snapshots");
  await rm(snapshotsDir, { recursive: true, force: true });
  await mkdir(snapshotsDir, { recursive: true });
  const snapshots: TutorialSnapshots = {};
  for (const tutorial of input.tutorials) {
    const started = performance.now();
    const source: Manifest = JSON.parse(await readFile(resolve(input.fixturesDir, tutorial.fixture, "package.json"), "utf8"));
    const local = Object.entries(source.dependencies ?? {}).filter(([, specifier]) => specifier.startsWith("workspace:")).map(([name]) => name);
    const packages = closure(local);
    // Include build dependencies (such as the console's CMS), but pack only the runtime closure below.
    run(resolve(repoRoot, "node_modules/.bin/vp"), ["run", "--cache", ...packages.flatMap(name => ["--filter", `${name}...`]), "build"]);

    const work = resolve(workDir, tutorial.slug);
    const tarballDir = resolve(work, "tarballs");
    await rm(work, { recursive: true, force: true });
    await mkdir(tarballDir, { recursive: true });
    const tarballs: Record<string, string> = {};
    for (const name of packages) {
      const before = new Set(await readdir(tarballDir));
      run("pnpm", ["pack", "--pack-destination", tarballDir], workspace.get(name)!.dir);
      const file = (await readdir(tarballDir)).find(candidate => !before.has(candidate));
      if (!file) throw new Error(`pnpm pack wrote no tarball for ${name}.`);
      await sortPackedManifest(resolve(tarballDir, file), resolve(work, "unpacked"));
      tarballs[name] = `file:./tarballs/${file}`;
    }

    // `legacy-peer-deps` installs no peers, so the required peers of the packed packages become dependencies.
    const peers: Record<string, string> = {};
    for (const name of packages) {
      const { peerDependencies = {}, peerDependenciesMeta = {} } = workspace.get(name)!.manifest;
      for (const [peer, specifier] of Object.entries(peerDependencies)) {
        if (!peerDependenciesMeta[peer]?.optional && !tarballs[peer] && !peer.startsWith("@types/")) peers[peer] = specifier;
      }
    }
    const resolved: Manifest = JSON.parse(resolveManifest(JSON.stringify({ name: source.name, private: true, dependencies: { ...peers, ...source.dependencies } }), input.versions));
    const dependencies = { ...resolved.dependencies };
    for (const name of local) dependencies[name] = tarballs[name]!;
    await writeFile(resolve(work, "package.json"), `${JSON.stringify({ ...resolved, dependencies, overrides: tarballs }, null, 2)}\n`);
    // npm refuses `overrides` that touch the optional peers of vite-hub.
    await writeFile(resolve(work, ".npmrc"), "legacy-peer-deps=true\n");

    const lockfile = tutorialLockfile(input.locksDir, tutorial.slug);
    const output = execFileSync(process.execPath, [resolve(import.meta.dirname, "snapshot-worker.mjs"), work, snapshotsDir, tutorial.slug, lockfile], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const written: { files: string[], sha256: string, bytes: number, compressed: number } = JSON.parse(output.trim().split("\n").at(-1)!);
    snapshots[tutorial.slug] = { parts: written.files.map(file => `${input.baseURL}/snapshots/${file}`), sha256: written.sha256 };
    await rm(work, { recursive: true, force: true });
    console.info(`[tutorials] ${tutorial.slug}: ${(written.bytes / 2 ** 20).toFixed(1)} MiB of node_modules, ${(written.compressed / 2 ** 20).toFixed(1)} MiB in ${written.files.length} parts, sha256 ${written.sha256.slice(0, 12)}, built in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
  // After the build, which can update the lockfiles.
  const file: SnapshotsFile = { inputs: await tutorialSnapshotInputs(input), tutorials: snapshots };
  await writeFile(resolve(outDir, "snapshots.json"), `${JSON.stringify(file, null, 2)}\n`);
  return snapshots;
}

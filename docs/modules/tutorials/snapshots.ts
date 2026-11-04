import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveManifest } from "./build";

import type { RunnableTutorialSource, WorkspaceVersions } from "./build";

/** The URLs of the snapshot parts of each tutorial, by slug. */
export type TutorialSnapshots = Record<string, string[]>;

interface Manifest {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** Reads the parts that the last `buildTutorialSnapshots` wrote, or nothing. */
export async function readTutorialSnapshots(outDir: string): Promise<TutorialSnapshots | undefined> {
  return readFile(resolve(outDir, "snapshots.json"), "utf8").then(JSON.parse, () => undefined);
}

/**
 * Builds the `node_modules` snapshot of each tutorial, so its workspace skips `npm install` in the browser.
 *
 * For each tutorial this builds and packs the workspace packages that the fixture uses, so the snapshot holds the code
 * that the docs describe. It installs them with the other dependencies of the fixture through
 * `createNodeModulesSnapshot` in `snapshot-worker.mjs`, and writes the gzip parts to `<outDir>/snapshots/` with `snapshots.json` beside them.
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
    run(resolve(repoRoot, "node_modules/.bin/vp"), ["run", "--cache", ...packages.flatMap(name => ["--filter", name]), "build"]);

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

    const output = execFileSync(process.execPath, [resolve(import.meta.dirname, "snapshot-worker.mjs"), work, snapshotsDir, tutorial.slug], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const written: { files: string[], bytes: number, compressed: number } = JSON.parse(output.trim().split("\n").at(-1)!);
    snapshots[tutorial.slug] = written.files.map(file => `${input.baseURL}/snapshots/${file}`);
    await rm(work, { recursive: true, force: true });
    console.info(`[tutorials] ${tutorial.slug}: ${(written.bytes / 2 ** 20).toFixed(1)} MiB of node_modules, ${(written.compressed / 2 ** 20).toFixed(1)} MiB in ${written.files.length} parts, built in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
  await writeFile(resolve(outDir, "snapshots.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
  return snapshots;
}

import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const yarnOutputs = new Set(["cache", "unplugged", "install-state.gz"]);
const rootOutputs = new Set([".pnp.cjs", ".pnp.loader.mjs", ".pnp.data.json"]);

export interface GitHubInstallSnapshot {
  checkout: string;
  directory: string;
  identities: ReadonlyMap<string, { dev: string; ino: string }>;
  managedDirectories: ReadonlySet<string>;
  close(): Promise<void>;
}

/** Copy mutable provider inputs into a private host directory before validation. */
export async function createGitHubInstallSnapshot(target: string): Promise<GitHubInstallSnapshot> {
  const checkout = await realpath(target);
  const directory = await mkdtemp(join(checkout, ".git", "vitehub-dependency-snapshot-"));
  const identities = new Map<string, { dev: string; ino: string }>();
  const managedDirectories = new Set([""]);
  try {
    const root = await lstat(checkout, { bigint: true });
    identities.set("", { dev: String(root.dev), ino: String(root.ino) });
    // Node rejects copying an ancestor into itself before running the filter.
    // Copy each entry so the protected metadata directory is never traversed.
    for (const entry of await readdir(checkout)) {
      if (entry === ".git") continue;
      await cp(join(checkout, entry), join(directory, entry), {
        recursive: true, dereference: false, verbatimSymlinks: true,
        filter: async source => {
          const path = relative(checkout, source);
          const parts = path.split(sep);
          if (basename(source) === "node_modules") {
            managedDirectories.add(relative(checkout, dirname(source)));
            return false;
          }
          if (basename(source) === ".git"
            || rootOutputs.has(path) || parts[0] === ".yarn" && yarnOutputs.has(parts[1]!)) return false;
          const info = await lstat(source, { bigint: true });
          if (path === ".yarn" && !info.isDirectory()) throw new Error("Yarn installation output must use a regular checkout directory.");
          if (info.isDirectory()) identities.set(path, { dev: String(info.dev), ino: String(info.ino) });
          return true;
        },
      });
    }
    await chmod(directory, 0o700);
    return { checkout, directory, identities, managedDirectories, close: async () => await rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Publish package-manager outputs without following replaced provider directories. */
export async function publishGitHubInstallSnapshot(snapshot: GitHubInstallSnapshot, signal?: AbortSignal): Promise<void> {
  let outputDirectory = snapshot.directory;
  let transfer: string | undefined;
  // TMPDIR can use another filesystem. Stage output under protected Git
  // metadata so each publication can still use an atomic local rename.
  if (String((await lstat(outputDirectory, { bigint: true })).dev) !== snapshot.identities.get("")?.dev) {
    transfer = await mkdtemp(join(snapshot.checkout, ".git", "vitehub-dependency-output-"));
    try { await cp(outputDirectory, transfer, { recursive: true, dereference: false, verbatimSymlinks: true }); }
    catch (error) { await rm(transfer, { recursive: true, force: true }); throw error; }
    outputDirectory = transfer;
  }
  async function publish(path: string, names: string[], yarn = false) {
    const identity = snapshot.identities.get(path);
    if (!identity) throw new Error("Dependency output directory changed during installation.");
    // Starting a child pins cwd before checking its identity. All destination
    // operations stay relative to that inode even if the provider renames it.
    await exec(process.execPath, ["--input-type=module", "--eval", `
      import { lstat, mkdir, rename, rm } from "node:fs/promises";
      import { join } from "node:path";
      const [dev, ino, source, names, yarn] = process.argv.slice(1);
      const info = await lstat(".", { bigint: true });
      if (String(info.dev) !== dev || String(info.ino) !== ino) throw new Error("Dependency output directory changed during installation.");
      const outputs = JSON.parse(names);
      const present = await Promise.all(outputs.map(name => lstat(join(source, name)).then(() => true, error => {
        if (error.code === "ENOENT") return false;
        throw error;
      })));
      if (yarn === "true") {
        if (!present.some(Boolean) && !await lstat(".yarn").catch(error => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })) process.exit(0);
        await mkdir(".yarn").catch(error => { if (error.code !== "EEXIST") throw error; });
        const expected = await lstat(".yarn", { bigint: true });
        if (!expected.isDirectory()) throw new Error("Yarn output directory must not be a symbolic link.");
        process.chdir(".yarn");
        const actual = await lstat(".", { bigint: true });
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("Yarn output directory changed during installation.");
      }
      for (const [index, name] of outputs.entries()) {
        await rm(name, { recursive: true, force: true });
        if (present[index]) await rename(join(source, name), name);
      }
    `, identity.dev, identity.ino, join(outputDirectory, path, yarn ? ".yarn" : ""), JSON.stringify(names), String(yarn)], {
      cwd: join(snapshot.checkout, path), signal,
    });
  }
  const managedDirectories = new Set(snapshot.managedDirectories);
  async function visit(path: string) {
    for (const entry of await readdir(join(outputDirectory, path), { withFileTypes: true })) {
      if (entry.name === "node_modules") managedDirectories.add(path);
      else if (!path && rootOutputs.has(entry.name) || path === ".yarn" && yarnOutputs.has(entry.name)) continue;
      else if (entry.isDirectory()) await visit(join(path, entry.name));
    }
  }
  try {
    await visit("");
    for (const path of managedDirectories) await publish(path, path ? ["node_modules"] : ["node_modules", ...rootOutputs]);
    await publish("", [...yarnOutputs], true);
  }
  finally { if (transfer) await rm(transfer, { recursive: true, force: true }); }
}

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { promisify } from "node:util";
import type { BoxSession } from "@vite-hub/box";

const exec = promisify(execFile);
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part) && !part.split(/[\\/]/).includes(".git");
};
const repairPaths = (paths: readonly string[]) => {
  if (paths.some(path => !path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git") || path === "." || path.includes("\0"))) {
    throw new Error("Repair paths must name files inside the assigned checkout.");
  }
};
async function boxCommand(session: BoxSession, command: string, args: string[], signal: AbortSignal) {
  const result = await session.exec(command, args, { signal });
  if (!result.ok) throw new Error(`Cannot synchronize repair Box files: ${result.stderr}`);
  return result.stdout;
}
async function boxParent(session: BoxSession, path: string, signal: AbortSignal) {
  let parent = session.cwd;
  for (const part of path.split("/").slice(0, -1)) {
    if (!part || part === ".") continue;
    const entry = (await session.files.list(parent, { signal })).find(entry => posix.basename(entry.path) === part);
    if (!entry) return false;
    if (entry.type !== "directory") throw new Error("Repair Box parent must be a regular directory.");
    parent = posix.join(parent, part);
  }
  return true;
}

/** Copy named provider edits before the host stages and validates its protected index. */
export async function importBoxRepairFiles(session: BoxSession, checkout: string, paths: readonly string[], signal: AbortSignal): Promise<void> {
  repairPaths(paths);
  const root = await realpath(checkout);
  for (const path of paths) {
    signal.throwIfAborted();
    const destination = join(root, path);
    let parent = dirname(destination);
    while (!await lstat(parent).catch(() => undefined)) parent = dirname(parent);
    if (!inside(root, await realpath(parent))) throw new Error("Repair destination parent must stay inside the checkout.");
    const remote = posix.join(session.cwd, path);
    const entry = await boxParent(session, path, signal)
      ? (await session.files.list(posix.dirname(remote), { signal })).find(entry => posix.basename(entry.path) === posix.basename(remote))
      : undefined;
    if (entry?.type === "directory") throw new Error("Repair paths must name individual files.");
    const contents = entry?.type === "file" ? await session.files.read(remote, { signal }) : undefined;
    if (entry?.type === "file" && !contents) throw new Error("The repair Box file disappeared during transfer.");
    const link = entry?.type === "symlink"
      ? (await boxCommand(session, "sh", ["-c", 'readlink "$1"', "sh", remote], signal)).replace(/\n$/, "") : undefined;
    const mode = entry?.type === "file"
      ? await boxCommand(session, "sh", ["-c", 'if test -x "$1"; then printf 755; else printf 644; fi', "sh", remote], signal) : undefined;
    await mkdir(dirname(destination), { recursive: true });
    if (!inside(root, await realpath(dirname(destination)))) throw new Error("Repair destination parent changed during transfer.");
    await rm(destination, { force: true });
    if (link !== undefined) await symlink(link, destination);
    else if (contents) { await writeFile(destination, contents); await chmod(destination, mode === "755" ? 0o755 : 0o644); }
  }
}

/** Refresh uses the Box's current source graph, including new and deleted files. */
export async function importBoxRepairWorkspace(session: BoxSession, checkout: string, signal: AbortSignal): Promise<void> {
  const remote = await boxCommand(session, "git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal);
  const local = (await exec("git", ["-C", checkout, "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { signal })).stdout;
  await importBoxRepairFiles(session, checkout, [...new Set([...remote.split("\0"), ...local.split("\0")].filter(Boolean))], signal);
}

/** Return installed artifacts to the live Box without copying protected host Git state. */
export async function publishBoxDependencies(session: BoxSession, checkout: string, signal: AbortSignal): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const outputs = new Set(["node_modules", ".pnp.cjs", ".pnp.loader.mjs", ".pnp.data.json", ".yarn/cache", ".yarn/unplugged", ".yarn/install-state.gz"]);
  async function visit(path: string) {
    for (const entry of await readdir(join(checkout, path), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".yarn") continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.name === "node_modules") outputs.add(child);
      else if (entry.isDirectory()) await visit(child);
    }
  }
  await visit("");
  async function visitBox(path: string) {
    for (const entry of await session.files.list(posix.join(session.cwd, path), { signal })) {
      const name = posix.basename(entry.path);
      if (name === ".git" || name === ".yarn") continue;
      const child = path ? `${path}/${name}` : name;
      if (name === "node_modules") outputs.add(child);
      else if (entry.type === "directory") await visitBox(child);
    }
  }
  await visitBox("");
  const present: string[] = [];
  for (const path of outputs) {
    if (await lstat(join(checkout, path)).catch(() => undefined)) present.push(path);
    if (await boxParent(session, path, signal)) await session.files.remove(posix.join(session.cwd, path), { recursive: true, signal });
  }
  if (!present.length) return;
  const directory = await mkdtemp(join(checkout, ".git", "vitehub-box-dependencies-"));
  const remote = posix.join(session.cwd, ".git", posix.basename(directory) + ".tar");
  try {
    const archive = join(directory, "dependencies.tar");
    await exec("tar", ["-C", checkout, "-cf", archive, "--", ...present], { signal });
    await session.files.write(remote, await readFile(archive), { signal });
    await boxCommand(session, "tar", ["-C", session.cwd, "--no-same-owner", "-xf", remote], signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await session.files.remove(remote, { signal }).catch(() => {});
  }
}

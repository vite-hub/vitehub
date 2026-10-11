import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { BoxSession } from "@vite-hub/box";

/** Import committed Box work before the host publishes it with host-owned credentials. */
export async function importBoxCommit(session: BoxSession, checkout: string, base: string, signal: AbortSignal): Promise<void> {
  const git = async (args: string[]) => {
    const result = await session.exec("git", args, { signal });
    if (!result.ok) throw new Error(`Cannot export the repair Box commit: ${result.stderr}`);
    return result.stdout.trim();
  };
  const head = await git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("The repair Box did not return a commit SHA.");
  if (head === base) return;
  await git(["merge-base", "--is-ancestor", base, head]);
  const remoteBundle = posix.join(session.cwd, `.vitehub-repair-${randomUUID()}.bundle`);
  const temporary = await mkdtemp(join(tmpdir(), "vitehub-repair-bundle-"));
  try {
    await git(["bundle", "create", remoteBundle, "HEAD", `^${base}`]);
    const contents = await session.files.read(remoteBundle, { signal });
    if (!contents) throw new Error("The repair Box bundle is unavailable.");
    const bundle = join(temporary, "repair.bundle");
    await writeFile(bundle, contents);
    // Never let imported Git state run with GitHub credentials or inherited Git overrides.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GH_|GITHUB_|GIT_)/i.test(key)));
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_NOSYSTEM = "1";
    const localGit = async (args: string[]) => (await promisify(execFile)("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", ...args], { env, signal })).stdout.trim();
    const previous = await localGit(["rev-parse", "HEAD"]);
    await localGit(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--", bundle, "HEAD"]);
    if (await localGit(["rev-parse", "FETCH_HEAD"]) !== head) throw new Error("The repair Box HEAD changed during export.");
    await localGit(["merge-base", "--is-ancestor", base, head]);
    // A broker commit may already include the imported Box ancestor. Never
    // replace it with that older HEAD, or overwrite a divergent host repair.
    if (await localGit(["merge-base", "--is-ancestor", head, previous]).then(() => true, () => false)) return;
    await localGit(["merge-base", "--is-ancestor", previous, head]);
    // A two-tree update preserves unrelated host edits and refuses conflicting
    // local changes. Keep the protected index aligned with the imported parent.
    await localGit(["read-tree", "-u", "-m", previous, head]);
    await localGit(["update-ref", "HEAD", head, previous]);
  } finally {
    // Cleanup must not hide an import error or prevent publication of an imported commit.
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    await session.files.remove(remoteBundle, { signal }).catch(() => {});
  }
}

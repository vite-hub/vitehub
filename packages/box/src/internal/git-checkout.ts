import type { ResolvedBoxCheckout } from "../index.ts";

interface GitCheckoutCommandResult {
  readonly stdout: string;
}

interface GitCheckoutCommandRunner {
  readonly abortSignal?: AbortSignal;
  run(args: readonly string[]): Promise<GitCheckoutCommandResult>;
}

export async function materializeGitCheckout(
  checkout: ResolvedBoxCheckout,
  workspace: string,
  runner: GitCheckoutCommandRunner,
) {
  await run("initialize", ["init", "--quiet", workspace]);
  await run("configure remote", ["-C", workspace, "remote", "add", "--", "origin", checkout.remote]);
  await run("fetch ref", [
    "-C",
    workspace,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=100",
    "origin",
    "--",
    checkout.ref,
  ]);
  const revision = (
    await run("resolve revision", ["-C", workspace, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])
  ).stdout
    .trim()
    .toLowerCase();
  if (revision !== checkout.sha) {
    throw new Error(
      `[vitehub] Box checkout revision mismatch: expected ${checkout.sha}, received ${revision || "<empty>"}.`,
    );
  }
  await run("check out revision", [
    "-C",
    workspace,
    "checkout",
    "--quiet",
    "--detach",
    checkout.sha,
  ]);

  async function run(operation: string, args: readonly string[]) {
    runner.abortSignal?.throwIfAborted();
    try {
      const result = await runner.run(args);
      runner.abortSignal?.throwIfAborted();
      return result;
    } catch {
      runner.abortSignal?.throwIfAborted();
      throw new Error(`[vitehub] Box checkout failed to ${operation}.`);
    }
  }
}

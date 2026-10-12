import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Read host checkout proof when a synchronize event changes the claimed head. */
export function createProviderHeadReader(
  providerDirectory: () => string | undefined,
  pushedHead: () => string | undefined,
): () => Promise<string | undefined> {
  return async () => {
    const cwd = providerDirectory();
    if (!cwd) return pushedHead();
    const result = await exec("git", ["rev-parse", "--verify", "HEAD"], {
      cwd, encoding: "utf8", timeout: 3000, maxBuffer: 1024,
    });
    return result.stdout.trim();
  };
}

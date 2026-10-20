import type { BoxFileEntry } from "../index.ts";
import { boxErrorDiagnostics } from "../error-diagnostics.ts";
import { shellQuote } from "./remote.ts";
import type { RuntimeSession } from "./session.ts";

type CommandResult = Awaited<ReturnType<RuntimeSession["run"]>>;

export async function listCommandFiles(
  run: RuntimeSession["run"],
  options: { abortSignal?: AbortSignal; path: string; recursive?: boolean },
  failure: (result: CommandResult) => Error,
): Promise<BoxFileEntry[]> {
  options.abortSignal?.throwIfAborted();
  const result = await run({
    abortSignal: options.abortSignal,
    command: `find ${shellQuote(options.path)} -mindepth 1 ${options.recursive ? "" : "-maxdepth 1 "}-printf '%y\\t%s\\t%p\\0'`,
  });
  if (result.exitCode !== 0) throw failure(result);
  return result.stdout.split("\0").filter(Boolean).map((entry) => {
    const kindSeparator = entry.indexOf("\t");
    const sizeSeparator = entry.indexOf("\t", kindSeparator + 1);
    const kind = entry.slice(0, kindSeparator);
    const size = entry.slice(kindSeparator + 1, sizeSeparator);
    const path = entry.slice(sizeSeparator + 1);
    if (kindSeparator < 1 || sizeSeparator < 0 || !path)
      throw boxErrorDiagnostics.BOX_R0107({ message: `[vitehub] Box returned an invalid file entry for ${options.path}.` });
    return {
      path,
      size: kind === "f" ? Number(size) : undefined,
      type: kind === "d" ? "directory" as const : kind === "l" ? "symlink" as const : "file" as const,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

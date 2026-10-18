import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { BoxResolvedToolchain, BoxToolchain, BoxToolchainInput } from "../index.ts";
import { boxErrorDiagnostics } from "../error-diagnostics.ts";
import { acquireFileLock } from "./file-lock.ts";
import { isRuntimeNumber, isRuntimeString } from "./runtime-type.ts";
import { normalizeToolchain, provisionToolchain, toolchainProjectFiles, verifyToolchain, type ToolchainCommandResult } from "./toolchain.ts";

export interface HostToolchainOptions {
  abortSignal?: AbortSignal;
  /** Shared cache directory. Defaults to `$XDG_CACHE_HOME/vitehub/toolchains`. */
  cacheRoot?: string;
  /** Environment of the install and verification shell. Its PATH follows the toolchain entries. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Default host cache. A configured Box stateRoot keeps toolchains beside durable state. */
export function hostToolchainCacheRoot(stateRoot?: string): string {
  return stateRoot
    ? join(stateRoot, "toolchains")
    : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "vitehub", "toolchains");
}

export async function readHostProjectFiles(
  directory: string,
  paths: readonly string[] = toolchainProjectFiles,
): Promise<Record<string, string | undefined>> {
  const files: Record<string, string | undefined> = {};
  for (const path of paths) {
    files[path] = await readFile(join(directory, path), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
  }
  return files;
}

/**
 * Provision a project-pinned toolchain for a directory on this host.
 * Concurrent processes that share the cache download each version once.
 */
export async function provisionHostToolchain(
  toolchain: BoxToolchainInput,
  directory: string,
  options: HostToolchainOptions = {},
): Promise<BoxResolvedToolchain> {
  if (process.platform === "win32") {
    throw boxErrorDiagnostics.BOX_R0150({ message: "[vitehub] Box toolchain provisioning requires a Linux or macOS host." });
  }
  const cacheRoot = resolve(options.cacheRoot ?? hostToolchainCacheRoot());
  await mkdir(cacheRoot, { mode: 0o700, recursive: true });
  const cache = await lstat(cacheRoot);
  const uid = process.getuid?.();
  if (!cache.isDirectory() || (uid !== undefined && cache.uid !== uid) || (cache.mode & 0o022) !== 0) {
    throw boxErrorDiagnostics.BOX_R0154({ message: `[vitehub] Box toolchain cache must be a directory owned by the current user and not writable by others: ${cacheRoot}` });
  }
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const run = async (script: string, environment = env): Promise<ToolchainCommandResult> => {
    try {
      const result = await promisify(execFile)("sh", ["-c", script], {
        cwd: cacheRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        signal: options.abortSignal,
      });
      return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
    }
    catch (error) {
      options.abortSignal?.throwIfAborted();
      // execFile rejects a non-zero exit with its numeric code and captured output.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (!isRuntimeNumber(code)) throw error;
      const output = (name: "stderr" | "stdout") => {
        const value = error instanceof Error && name in error ? Reflect.get(error, name) : undefined;
        return isRuntimeString(value) ? value : "";
      };
      return { exitCode: code, stderr: output("stderr"), stdout: output("stdout") };
    }
  };
  const toolchainResult = await provisionToolchain(toolchain, {
    abortSignal: options.abortSignal,
    cacheRoot,
    lock: async key => await acquireFileLock(join(cacheRoot, `.${key}.lock`), options.abortSignal),
    readProjectFiles: async paths => await readHostProjectFiles(directory, paths),
    run,
    scratch: cacheRoot,
    async write(path, contents) {
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      await writeFile(path, contents, { mode: 0o600 });
    },
  });
  await verifyToolchain(toolchainResult, cacheRoot, async script => await run(script, {
    ...env,
    PATH: toolchainPath(toolchainResult, env.PATH),
  }));
  return toolchainResult;
}

/** PATH with the toolchain entries before the base PATH. */
export function toolchainPath(toolchain: BoxResolvedToolchain, base: string | undefined): string {
  return [...toolchain.bin, base].filter(Boolean).join(delimiter);
}

/** Validate a toolchain declaration and provision it for a host directory. */
export async function prepareHostToolchain(
  declaration: BoxToolchain,
  directory: string,
  options: HostToolchainOptions = {},
): Promise<BoxResolvedToolchain> {
  return await provisionHostToolchain(normalizeToolchain(declaration)!, directory, options);
}

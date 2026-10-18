import type {
  Sandbox,
  SandboxOpenOptions,
  SandboxRuntime,
  SandboxRuntimeInput,
  SandboxRuntimePlan,
  SandboxSession,
  ResolvedSandboxRequirementInput,
} from "../index.ts";
import { normalizeExecutionAuthority, type ExecutionAuthority } from "@vite-hub/runtime";
import { materializeGitCheckout } from "./git-checkout.ts";
import {
  sandboxRequirementError,
  sandboxRequirementPlan,
  sandboxRequirementSecrets,
  sandboxRequirementSignal,
} from "./requirements.ts";
import { createSandboxSession, type RuntimeSession } from "./session.ts";
import { sandboxErrorDiagnostics } from "../error-diagnostics.ts"

interface RemoteRuntimeOptions {
  readonly executionAuthority: ExecutionAuthority;
  readonly home?: string;
  readonly runtime: string;
  readonly workspace?: string;
  readonly preserveWorkspace?: boolean;
}

export async function resolveRemoteSandboxRuntime(
  runtime: SandboxRuntime,
  requirements: readonly string[],
): Promise<Sandbox> {
  const resolvedRequirements = requirements.map((command): ResolvedSandboxRequirementInput => ({
    args: [],
    command,
    name: command,
  }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(resolvedRequirements)),
  );
  const input: SandboxRuntimeInput = {
    identity: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    plan: {
      env: {},
      files: {},
      state: [],
    },
    requirements: resolvedRequirements,
  };
  const prepared = await runtime.prepare(input);
  const plan = Object.freeze({
    ...prepared,
    executionAuthority: normalizeExecutionAuthority(prepared.executionAuthority),
    home: Object.freeze({
      state: Object.freeze(prepared.home?.state || []),
    }),
  });

  return Object.freeze({
    async open(options?: SandboxOpenOptions) {
      options?.signal?.throwIfAborted();
      return await runtime.open(input, {
        ...options,
        executionAuthority: plan.executionAuthority,
      });
    },
    plan,
  });
}

export function remoteSandboxPlan(
  input: SandboxRuntimeInput,
  options: RemoteRuntimeOptions,
): SandboxRuntimePlan {
  assertRemoteInput(input, options.runtime);
  return {
    cache: { state: "disposable" },
    environment: { env: {} },
    executionAuthority: options.executionAuthority,
    identity: input.identity,
    requirements: sandboxRequirementPlan(input.requirements),
    runtime: options.runtime,
    workspace: {
      state: "disposable",
      workDir: ".",
    },
  };
}

export async function openRemoteSandbox(
  input: SandboxRuntimeInput,
  runtimeSession: RuntimeSession,
  options: RemoteRuntimeOptions & {
    initialize?: (session: SandboxSession, context: { signal?: AbortSignal }) => Promise<void>;
    signal?: AbortSignal;
  },
  /** Base environment of the runtime session. Toolchain provisioning sets its PATH. */
  environment: Record<string, string>,
) {
  assertRemoteInput(input, options.runtime);
  const session = createSandboxSession(runtimeSession, {
    executionAuthority: options.executionAuthority,
    initialize: options.initialize,
    signal: options.signal,
  });
  try {
    await materializeRemotePlan(input, runtimeSession, options, environment);
    await options.initialize?.(session, { signal: options.signal });
    return session;
  } catch (error) {
    try {
      await session.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `[vitehub] ${options.runtime} Sandbox initialization failed: ${remoteFailureMessage(error)} Cleanup failed: ${remoteFailureMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

function remoteFailureMessage(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

export async function resolveRemoteEnvironment(
  input: SandboxRuntimeInput,
  options: Pick<RemoteRuntimeOptions, "home" | "workspace">,
) {
  const home = options.home ?? "/home/vitehub";
  const workspace = options.workspace ?? "/workspace";
  const env: Record<string, string> = {
    HOME: home,
    INIT_CWD: workspace,
    OLDPWD: workspace,
    PWD: workspace,
    XDG_CACHE_HOME: joinRemotePath(home, ".cache"),
    XDG_CONFIG_HOME: joinRemotePath(home, ".config"),
    XDG_STATE_HOME: joinRemotePath(home, ".local/state"),
  };
  for (const [name, resolveValue] of Object.entries(input.plan.env)) env[name] = await resolveValue();
  return env;
}

async function materializeRemotePlan(
  input: SandboxRuntimeInput,
  session: RuntimeSession,
  options: Pick<RemoteRuntimeOptions, "home" | "workspace" | "preserveWorkspace"> & { signal?: AbortSignal },
  environment: Record<string, string>,
) {
  const home = options.home ?? "/home/vitehub";
  const workspace = options.workspace ?? "/workspace";
  const abortSignal = options.signal;
  const diagnosticSecrets = [...sandboxRequirementSecrets(
    Object.keys(input.plan.env).map(name => environment[name]!),
  )];
  for (const path of new Set([home, ...(options.preserveWorkspace ? [] : [workspace])])) {
    if (await session.existsFile({ abortSignal, path }))
      await session.removeFile({ abortSignal, path, recursive: true });
  }
  await session.makeDirectory({ abortSignal, path: home, recursive: true });
  await session.makeDirectory({ abortSignal, path: workspace, recursive: true });
  for (const [path, file] of Object.entries(input.plan.files)) {
    const content = await file.resolve();
    diagnosticSecrets.push(...sandboxRequirementSecrets([content]));
    await session.makeDirectory({
      abortSignal,
      path: dirnameRemotePath(joinRemotePath(home, path)),
      recursive: true,
    });
    await session.writeBinaryFile({
      abortSignal,
      content,
      path: joinRemotePath(home, path),
    });
  }
  if (input.checkout) {
    await materializeGitCheckout(input.checkout, workspace, {
      abortSignal,
      async run(args) {
        const result = await session.run({
          abortSignal,
          command: ["git", ...args.map(shellQuote)].join(" "),
          workingDirectory: workspace,
        });
        if (result.exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0121({ message: result.stderr });
        return { stdout: result.stdout };
      },
    });
  }
  if (input.toolchain) await provisionRemoteToolchain(input, session, { abortSignal, home, workspace }, environment);
  await validateRequirements(
    session,
    input.requirements,
    workspace,
    abortSignal,
    diagnosticSecrets,
  );
}

/**
 * Remote Sandboxes do not share a cache. Reuse an exact image node, otherwise upload
 * the verified toolchain into the Sandbox Home cache for this session.
 */
async function provisionRemoteToolchain(
  input: SandboxRuntimeInput,
  session: RuntimeSession,
  options: { abortSignal?: AbortSignal; home: string; workspace: string },
  environment: Record<string, string>,
) {
  const { abortSignal, home, workspace } = options;
  const { provisionToolchain, readProjectFilesWithShell, verifyToolchain } = await import("./toolchain.ts");
  const run = async (script: string) => await session.run({
    abortSignal,
    command: `sh -c ${shellQuote(script)}`,
    workingDirectory: workspace,
  });
  const basePath = await run(`printf '%s' "$PATH"`);
  if (basePath.exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0154({ message: `[vitehub] Sandbox toolchain could not read the Sandbox PATH: ${basePath.stderr.trim()}` });
  const cacheRoot = joinRemotePath(home, ".cache/vitehub/toolchains");
  const toolchain = await provisionToolchain(input.toolchain!, {
    abortSignal,
    cacheRoot,
    readProjectFiles: async paths => await readProjectFilesWithShell(run, workspace, paths),
    reuseExactNode: true,
    run,
    scratch: cacheRoot,
    async write(path, content) {
      await session.makeDirectory({ abortSignal, path: dirnameRemotePath(path), recursive: true });
      await session.writeBinaryFile({ abortSignal, content, path });
    },
  });
  environment.PATH = [...toolchain.bin, basePath.stdout].filter(Boolean).join(":");
  // Runtime sessions read the shared environment object, so this check uses the final PATH.
  await verifyToolchain(toolchain, cacheRoot, async script => await session.run({ abortSignal, command: script, workingDirectory: workspace }));
  session.toolchain = toolchain;
}

function joinRemotePath(...parts: string[]) {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

function dirnameRemotePath(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

async function validateRequirements(
  session: RuntimeSession,
  requirements: readonly ResolvedSandboxRequirementInput[],
  workspace: string,
  abortSignal: AbortSignal | undefined,
  secrets: readonly string[],
) {
  for (const requirement of requirements) {
    const command = ["command -v", shellQuote(requirement.command), ">/dev/null"];
    if (requirement.args.length)
      command.push("&&", shellQuote(requirement.command), ...requirement.args.map(shellQuote));
    let result: Awaited<ReturnType<RuntimeSession["run"]>>;
    try {
      result = await session.run({
        abortSignal: sandboxRequirementSignal(requirement, abortSignal),
        command: command.join(" "),
        workingDirectory: workspace,
      });
    } catch (cause) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      throw sandboxRequirementError(requirement, cause, secrets);
    }
    if (result.exitCode !== 0)
      throw sandboxRequirementError(requirement, result, secrets);
  }
}

function assertRemoteInput(input: SandboxRuntimeInput, runtime: string) {
  if (input.cwd)
    throw sandboxErrorDiagnostics.SANDBOX_R0122({ message: `[vitehub] ${runtime} cannot mount a host Sandbox cwd; use Workspace instead.` });
  if (input.plan.state.length)
    throw sandboxErrorDiagnostics.SANDBOX_R0123({ message: `[vitehub] ${runtime} does not provide durable Sandbox Home state.` });
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function collectProcessOutput(
  process: {
    stderr(): Promise<string>;
    stdout(): Promise<string>;
    wait(): Promise<{ exitCode: number }>;
  },
) {
  const [{ exitCode }, stdout, stderr] = await Promise.all([
    process.wait(),
    process.stdout(),
    process.stderr(),
  ]);
  return { exitCode, stderr, stdout };
}

export function snapshotStream(read: () => Promise<string>) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(new TextEncoder().encode(await read()));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

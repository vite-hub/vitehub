import type {
  Box,
  BoxOpenOptions,
  BoxPlan,
  BoxRuntime,
  BoxRuntimeInput,
  BoxSession,
  ResolvedBoxRequirementInput,
} from "../index.ts";
import { materializeGitCheckout } from "./git-checkout.ts";
import { createBoxSession, type RuntimeSession } from "./session.ts";

interface RemoteRuntimeOptions {
  readonly home?: string;
  readonly isolation: BoxPlan["isolation"];
  readonly runtime: string;
  readonly workspace?: string;
  readonly preserveWorkspace?: boolean;
}

export async function resolveRemoteBoxRuntime(
  runtime: BoxRuntime,
  requirements: readonly string[],
): Promise<Box> {
  const resolvedRequirements = requirements.map((command): ResolvedBoxRequirementInput => ({
    args: [],
    command,
    name: command,
  }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(resolvedRequirements)),
  );
  const input: BoxRuntimeInput = {
    identity: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    plan: {
      env: {},
      files: {},
      state: [],
    },
    requirements: resolvedRequirements,
  };
  const plan = await runtime.prepare(input);

  return Object.freeze({
    async open(options?: BoxOpenOptions) {
      options?.signal?.throwIfAborted();
      return await runtime.open(input, options);
    },
    plan,
  });
}

export function remoteBoxPlan(
  input: BoxRuntimeInput,
  options: RemoteRuntimeOptions,
): BoxPlan {
  assertRemoteInput(input, options.runtime);
  return {
    cache: { state: "disposable" },
    environment: { env: {} },
    identity: input.identity,
    isolation: options.isolation,
    requirements: input.requirements.map(({ command, name }) => ({ command, name })),
    runtime: options.runtime,
    workspace: {
      state: "disposable",
      workDir: ".",
    },
  };
}

export async function openRemoteBox(
  input: BoxRuntimeInput,
  runtimeSession: RuntimeSession,
  options: RemoteRuntimeOptions & {
    initialize?: (session: BoxSession, context: { signal?: AbortSignal }) => Promise<void>;
    signal?: AbortSignal;
  },
) {
  assertRemoteInput(input, options.runtime);
  const session = createBoxSession(runtimeSession, {
    initialize: options.initialize,
    signal: options.signal,
  });
  try {
    await materializeRemotePlan(input, runtimeSession, options);
    await options.initialize?.(session, { signal: options.signal });
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

export async function resolveRemoteEnvironment(
  input: BoxRuntimeInput,
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
  input: BoxRuntimeInput,
  session: RuntimeSession,
  options: Pick<RemoteRuntimeOptions, "home" | "workspace" | "preserveWorkspace"> & { signal?: AbortSignal },
) {
  const home = options.home ?? "/home/vitehub";
  const workspace = options.workspace ?? "/workspace";
  const abortSignal = options.signal;
  for (const path of new Set([home, ...(options.preserveWorkspace ? [] : [workspace])])) {
    if (await session.existsFile({ abortSignal, path }))
      await session.removeFile({ abortSignal, path, recursive: true });
  }
  await session.makeDirectory({ abortSignal, path: home, recursive: true });
  await session.makeDirectory({ abortSignal, path: workspace, recursive: true });
  for (const [path, file] of Object.entries(input.plan.files)) {
    await session.makeDirectory({
      abortSignal,
      path: dirnameRemotePath(joinRemotePath(home, path)),
      recursive: true,
    });
    await session.writeBinaryFile({
      abortSignal,
      content: await file.resolve(),
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
        if (result.exitCode !== 0) throw new Error(result.stderr);
        return { stdout: result.stdout };
      },
    });
  }
  await validateRequirements(session, input.requirements, workspace, abortSignal);
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
  requirements: readonly ResolvedBoxRequirementInput[],
  workspace: string,
  abortSignal: AbortSignal | undefined,
) {
  for (const requirement of requirements) {
    const command = ["command -v", shellQuote(requirement.command), ">/dev/null"];
    if (requirement.args.length)
      command.push("&&", shellQuote(requirement.command), ...requirement.args.map(shellQuote));
    const result = await session.run({
      abortSignal,
      command: command.join(" "),
      workingDirectory: workspace,
    });
    if (result.exitCode !== 0)
      throw new Error(`[vitehub] Box requirement "${requirement.name}" failed.`);
  }
}

function assertRemoteInput(input: BoxRuntimeInput, runtime: string) {
  if (input.cwd)
    throw new Error(`[vitehub] ${runtime} cannot mount a host Box cwd; use Workspace instead.`);
  if (input.plan.state.length)
    throw new Error(`[vitehub] ${runtime} does not provide durable Box Home state.`);
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

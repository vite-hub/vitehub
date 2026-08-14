import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdtemp, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import { Readable } from "node:stream"
import type { ExecutionAuthority } from "@vite-hub/runtime"

import type {
  BoxRuntimePlan,
  BoxRuntime,
  BoxRuntimeInput,
  ResolvedBoxCheckout,
  ResolvedBoxFile,
  ResolvedBoxPlan,
  ResolvedBoxRequirementInput,
} from "../index.ts"
import { materializeGitCheckout } from "./git-checkout.ts"
import {
  boxRequirementError,
  boxRequirementPlan,
  boxRequirementSecrets,
  boxRequirementSignal,
} from "./requirements.ts"
import { markBuiltInBoxRuntime } from "./runtime.ts"
import { createBoxSession, type RuntimeSession } from "./session.ts"

export interface CrabboxOptions {
  /** Enables loopback port URLs when the target shares the ViteHub process network namespace. */
  network?: "direct"
  profile?: string
  /** Replaces an existing static lease for the shared sibling-workspace root. */
  reclaim?: boolean;
  /** Private durable storage on the target host for writable Box state. */
  stateRoot?: string;
}

interface CrabboxSandboxOptions extends CrabboxOptions {
  checkout?: ResolvedBoxCheckout
  plan: ResolvedBoxPlan;
  requirements: readonly ResolvedBoxRequirementInput[]
  workspace?: string
}

interface CrabboxSessionOptions extends CrabboxSandboxOptions {
  stateHome: string
}

interface CrabboxRunOptions {
  abortSignal?: AbortSignal
  command: string
  env?: Record<string, string>
  localWorkingDirectory?: string
  sync?: boolean
  workingDirectory?: string
}

interface CrabboxSessionState {
  environmentFile: string;
  leaseId: string
  options: CrabboxSessionOptions
  processes: Set<ChildProcessWithoutNullStreams>
  releaseWorkspace: () => void
  remoteWorkspace: string
  root: string;
  statePaths: readonly string[]
  stateLease: CrabboxStateLease;
  syncedWorkspacePaths: readonly string[]
  tunnels: Map<number, CrabboxTunnel>
}

interface CrabboxTunnel {
  child: ChildProcessWithoutNullStreams
  localPort: Promise<number>
}

interface CrabboxStateLease {
  assertActive(): void;
  release(): Promise<void>;
  signal: AbortSignal;
}

const workspaceSessions = new Map<string, Promise<void>>();
const runtimeEnvironmentKeys = new Set([
  "CODEX_HOME",
  "HOME",
  "INIT_CWD",
  "OLDPWD",
  "PWD",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

const crabboxExecutionAuthority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "host" },
  isolation: "none",
  network: "unrestricted",
  processes: "arbitrary",
} as const satisfies ExecutionAuthority

export function createCrabboxRuntime(options: CrabboxOptions = {}): BoxRuntime {
  return markBuiltInBoxRuntime({
    name: "crabbox",
    async prepare(input) {
      const { workspace } = await resolveCrabboxInput(input, options)
      return {
        cache: { state: "disposable" },
        environment: { env: {} },
        executionAuthority: crabboxExecutionAuthority,
        home: options.stateRoot
          ? {
              state: input.plan.state.map(state => ({
                identity: createHash("sha256").update(JSON.stringify([
                  options.profile ?? null,
                  posix.normalize(options.stateRoot!),
                  state.key,
                  state.path,
                ])).digest("hex"),
                path: state.path,
              })),
            }
          : undefined,
        identity: input.identity,
        requirements: boxRequirementPlan(input.requirements),
        runtime: "crabbox",
        workspace: workspace
          ? { path: workspace, state: "authoritative" as const, workDir: "workspace" as const }
          : { state: "disposable" as const, workDir: "workspace" as const },
      } satisfies BoxRuntimePlan
    },
    async open(input, openOptions) {
      const { workspace } = await resolveCrabboxInput(input, options)
      const provider = createCrabboxProvider({
          ...options,
          ...(input.checkout ? { checkout: input.checkout } : {}),
          plan: input.plan,
          requirements: input.requirements,
          ...(workspace ? { workspace } : {}),
        })
      let initializedSession: ReturnType<typeof createBoxSession> | undefined
      const runtimeSession = await provider.createSession({
        abortSignal: openOptions?.signal,
        ...(openOptions?.initialize
          ? {
              async initialize(session: RuntimeSession) {
                initializedSession = createBoxSession(
                  session,
                  openOptions,
                  posix.join(session.defaultWorkingDirectory, "workspace"),
                )
                await openOptions.initialize!(initializedSession, { signal: openOptions.signal })
              },
            }
          : {}),
        sessionId: openOptions?.id,
      })
      return initializedSession ?? createBoxSession(
        runtimeSession,
        openOptions,
        posix.join(runtimeSession.defaultWorkingDirectory, "workspace"),
      )
    },
  })
}

async function resolveCrabboxInput(input: BoxRuntimeInput, options: CrabboxOptions) {
  const cwd = input.cwd
  if (!cwd && !input.checkout) throw new Error("[vitehub] The crabbox runtime requires box.cwd or box.checkout.")
  if (input.plan.state.length && (!options.stateRoot || !posix.isAbsolute(options.stateRoot))) {
    throw new Error(
      "[vitehub] The crabbox runtime requires an absolute stateRoot when box.home.state is declared.",
    )
  }
  if (
    input.plan.state.length &&
    options.stateRoot &&
    posix.dirname(posix.normalize(options.stateRoot)) === posix.normalize(options.stateRoot)
  ) {
    throw new Error("[vitehub] Box stateRoot must be a dedicated directory, not the filesystem root.")
  }
  const requestedWorkspace = cwd ? resolve(cwd) : undefined
  const workspace = requestedWorkspace
    ? await realpath(requestedWorkspace).catch(() => requestedWorkspace)
    : undefined
  const item = workspace ? await stat(workspace).catch(() => undefined) : undefined
  if (workspace && !item?.isDirectory())
    throw new Error(`[vitehub] Box workspace directory does not exist: ${workspace}`)
  return { workspace }
}

function createCrabboxProvider(options: CrabboxSandboxOptions) {
  return {
    async createSession(createOptions: {
      abortSignal?: AbortSignal
      initialize?: (session: RuntimeSession) => Promise<void>
      sessionId?: string
    } = {}) {
      const sessionOptions: CrabboxSessionOptions = {
        ...options,
        stateHome: await mkdtemp(join(tmpdir(), "vitehub-crabbox-state-")),
      }
      let releaseWorkspace = () => {};
      let stateLease = emptyStateLease();
      let leaseId: string | undefined;
      let remoteRoot: string | undefined;
      let remoteStatePaths: readonly string[] = [];
      let initializedState: string[] = [];
      try {
        if (options.workspace) releaseWorkspace = await acquireWorkspace(options.workspace, createOptions.abortSignal);
        leaseId = await warmup(sessionOptions, createOptions.abortSignal)
        const hasState = options.plan.state.length > 0;
        const setup = await runCrabbox(sessionOptions, leaseId, {
          abortSignal: createOptions.abortSignal,
          command: sessionSetupCommand(hasState ? options.stateRoot : undefined, Boolean(options.workspace)),
          ...(options.workspace ? { localWorkingDirectory: options.workspace } : {}),
          sync: Boolean(options.workspace),
        })
        if (setup.exitCode !== 0) throw crabboxError("create disposable Box cache", setup)
        const [root, remoteWorkspace, remotePath, remoteUser, remoteStateRoot] = lastLines(setup.stdout,
          hasState ? 5 : 4,
        );
        if (!/^\/tmp\/vitehub-box\.[A-Za-z0-9]+$/.test(root)) throw new Error(`[vitehub] Crabbox returned an invalid session root: ${root || "<empty>"}`)
        if (!posix.isAbsolute(remoteWorkspace)) throw new Error(`[vitehub] Crabbox returned an invalid workspace path: ${remoteWorkspace || "<empty>"}`,
          );
        if (
          hasState &&
          (!remoteStateRoot ||
            !posix.isAbsolute(remoteStateRoot) ||
            posix.dirname(remoteStateRoot) === remoteStateRoot)
        ) {
          throw new Error("[vitehub] Box stateRoot must resolve to a dedicated target directory.");
        }
        if (hasState && remotePathsOverlap(remoteStateRoot, remoteWorkspace)) {
          throw new Error("[vitehub] Box stateRoot must be outside the authoritative workspace.");
        }
        if (hasState) {
          sessionOptions.stateRoot = remoteStateRoot;
          remoteStatePaths = options.plan.state.map(state => remoteStatePath(remoteStateRoot, state.key));
        }
        remoteRoot = root;
        stateLease = await acquireRemoteState(sessionOptions, leaseId, createOptions.abortSignal);
        const bootstrapSignal = combineAbortSignals(createOptions.abortSignal, stateLease.signal);
        const materialized = await materializePlan(
          sessionOptions,
          leaseId,
          root,
          remotePath,
          remoteUser,
          bootstrapSignal,
        );
        initializedState = materialized.initializedState;
        if (options.checkout) {
          await materializeGitCheckout(options.checkout, remoteWorkspace, {
            abortSignal: bootstrapSignal,
            async run(args) {
              const result = await runCrabbox(sessionOptions, leaseId!, {
                abortSignal: bootstrapSignal,
                command: `${shellQuote(materialized.environmentFile)} git ${args.map(shellQuote).join(" ")}`,
              })
              if (result.exitCode !== 0) throw new Error("Git command failed.")
              return { stdout: result.stdout }
            },
          })
        }
        const syncedWorkspacePaths = options.workspace
          ? await listRemoteWorkspacePaths(sessionOptions, leaseId, remoteWorkspace, bootstrapSignal)
          : [];
        const session = createCrabboxSession({
            environmentFile: materialized.environmentFile,
            leaseId,
          options: sessionOptions,
          processes: new Set(),
          releaseWorkspace,
            remoteWorkspace,
          root,
            statePaths: remoteStatePaths,
            stateLease,
            syncedWorkspacePaths,
            tunnels: new Map(),
        }, createOptions.sessionId)
        try {
          await session.writeBinaryFile({ abortSignal: createOptions.abortSignal, content: new Uint8Array(), path: ".vitehub-copy-probe" })
          const probeCleanup = await session.run({ abortSignal: createOptions.abortSignal,
            command: `rm -- ${shellQuote(posix.join(root, ".vitehub-copy-probe"))}` })
          if (probeCleanup.exitCode !== 0) throw crabboxError("remove Crabbox copy probe", probeCleanup)
          await validateRequirements(
            session,
            options.requirements,
            createOptions.abortSignal,
            materialized.secrets,
            options.plan.state.length === 0,
          )
          await createOptions.initialize?.(session)
          return session
        }
        catch (error) {
          if (initializedState.length) {
            await runCrabbox(sessionOptions, leaseId, {
              command: `rm -rf -- ${initializedState.map(shellQuote).join(" ")}`,
            }).catch(() => undefined);
            initializedState = [];
          }
          try {
            await session.destroy?.()
          }
          catch {}
          throw error
        }
      }
      catch (error) {
        if (leaseId && initializedState.length) {
          await runCrabbox(sessionOptions, leaseId, {
            command: `rm -rf -- ${initializedState.map(shellQuote).join(" ")}`,
          }).catch(() => undefined);
        }
        if (leaseId && remoteRoot) {
          await runCrabbox(sessionOptions, leaseId, {
            command: removeDisposableRootCommand(remoteRoot),
          }).catch(() => undefined);
        }
        releaseWorkspace()
        await stateLease.release().catch(() => undefined);
        await rm(sessionOptions.stateHome, { force: true, recursive: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

function sessionSetupCommand(stateRoot: string | undefined, authoritativeWorkspace: boolean) {
  const state = stateRoot
    ? ` && mkdir -p -- ${shellQuote(stateRoot)} && state_root=$(realpath -- ${shellQuote(stateRoot)})`
    : "";
  const output = stateRoot
    ? `printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$root" "$workspace" "$PATH" "$(id -un)" "$state_root"`
    : `printf '%s\\n%s\\n%s\\n%s\\n' "$root" "$workspace" "$PATH" "$(id -un)"`;
  const workspace = authoritativeWorkspace
    ? `workspace=$(pwd -P) && ln -s "$workspace" "$root/workspace"`
    : `workspace="$root/workspace" && mkdir -m 700 "$workspace"`;
  return `root=$(mktemp -d /tmp/vitehub-box.XXXXXX) && trap 'rm -rf -- "$root"' EXIT && umask 077 && ${workspace} && home="$root/home" && mkdir -m 700 "$home"${state} && trap - EXIT && ${output}`;
}

async function materializePlan(
  options: CrabboxSessionOptions,
  leaseId: string,
  root: string,
  remotePath: string,
  remoteUser: string,
  abortSignal: AbortSignal | undefined,
) {
  if (!remotePath) throw new Error("[vitehub] Crabbox returned an empty command PATH.");
  if (!remoteUser) throw new Error("[vitehub] Crabbox returned an empty command user.");
  const home = posix.join(root, "home");
  const environmentFile = posix.join(root, ".vitehub-environment");
  const missingState = await findMissingState(options, leaseId, abortSignal);
  const seeds = new Map<number, Awaited<ReturnType<typeof resolveFiles>>>();
  for (const index of missingState)
    seeds.set(index, await resolveFiles(options.plan.state[index].seed));
  const files = await resolveFiles(options.plan.files);
  const environment = Object.fromEntries(
    await Promise.all(
      Object.entries(options.plan.env).map(async ([name, resolveValue]) => [
        name,
        await resolveValue(),
      ]),
    ),
  ) as Record<string, string>;

  const cleanup: string[] = [];
  const stateStaging = new Map<number, string>();
  for (const index of missingState) {
    const state = options.plan.state[index];
    const staging = `${remoteStatePath(options.stateRoot!, state.key)}.init-${randomUUID()}`;
    stateStaging.set(index, staging);
    cleanup.push(staging);
  }
  const script = [
    "set -eu",
    "umask 077",
    `mkdir -p -- ${shellQuote(home)}`,
    `chmod 700 ${shellQuote(home)}`,
  ];
  if (options.plan.state.length) {
    script.push(`mkdir -p -- ${shellQuote(options.stateRoot!)}`);
  }
  for (let index = 0; index < options.plan.state.length; index++) {
    const state = options.plan.state[index];
    const persistent = remoteStatePath(options.stateRoot!, state.key);
    if (missingState.has(index)) {
      const staging = stateStaging.get(index)!;
      cleanup.push(persistent);
      script.push(`mkdir -m 700 -- ${shellQuote(staging)}`);
      appendFiles(script, staging, seeds.get(index) || [], cleanup);
      script.push(`mv -- ${shellQuote(staging)} ${shellQuote(persistent)}`);
    } else {
      script.push(`test -d ${shellQuote(persistent)}`);
    }
    appendProjectionReconciliation(script, state, persistent, cleanup);
    script.push(`chmod 700 ${shellQuote(persistent)}`);
    const target = posix.join(home, state.path);
    script.push(
      `mkdir -p -- ${shellQuote(posix.dirname(target))}`,
      `ln -s -- ${shellQuote(persistent)} ${shellQuote(target)}`,
    );
  }
  appendFiles(script, home, files, cleanup);

  const assignments = Object.entries({
    HOME: home,
    LANG: "C.UTF-8",
    LOGNAME: remoteUser,
    PATH: remotePath,
    SHELL: "/bin/sh",
    TMPDIR: "/tmp",
    USER: remoteUser,
    XDG_CACHE_HOME: posix.join(home, ".cache"),
    XDG_CONFIG_HOME: posix.join(home, ".config"),
    XDG_STATE_HOME: posix.join(home, ".local", "state"),
    ...environment,
  })
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const wrapper = `#!/bin/sh\nexec env -i ${assignments} "$@"\n`;
  appendFile(script, environmentFile, new TextEncoder().encode(wrapper), 0o700, cleanup);
  if (cleanup.length) {
    script.splice(
      2,
      0,
      `trap ${shellQuote(`rm -rf -- ${cleanup.map(shellQuote).join(" ")}`)} EXIT HUP INT TERM`,
    );
    script.push("trap - EXIT HUP INT TERM");
  }
  await runCrabboxScript(options, leaseId, { abortSignal, script: `${script.join("\n")}\n` });
  return {
    environmentFile,
    initializedState: [...missingState].map((index) =>
      remoteStatePath(options.stateRoot!, options.plan.state[index].key)
    ),
    secrets: boxRequirementSecrets([
      ...Object.values(environment),
      ...files.map(file => file.contents),
      ...[...seeds.values()].flatMap(seed => seed.map(file => file.contents)),
    ]),
  };
}

function appendProjectionReconciliation(
  script: string[],
  state: ResolvedBoxPlan["state"][number],
  persistent: string,
  cleanup: string[],
) {
  const manifest = `${persistent}.projections`;
  const next = `${manifest}.next-${randomUUID()}`;
  const contents = state.projections
    .map((path) => Buffer.from(path).toString("base64"))
    .join("\n");
  appendFile(script, next, new TextEncoder().encode(contents ? `${contents}\n` : ""), 0o600, cleanup);
  cleanup.push(next);
  for (const path of state.projections) {
    const parent = posix.dirname(posix.join(persistent, path));
    script.push(
      `projection_parent=${shellQuote(parent)}`,
      `while [ ! -e "$projection_parent" ] && [ ! -L "$projection_parent" ]; do projection_parent=$(dirname -- "$projection_parent"); done`,
      `projection_parent=$(CDPATH= cd -P -- "$projection_parent" && pwd -P)`,
      `case "$projection_parent" in ${shellQuote(persistent)}|${shellQuote(`${persistent}/`)}*) ;; *) printf '%s\\n' 'Box projected path escapes writable state.' >&2; exit 1 ;; esac`,
    );
  }
  script.push(
    `test ! -e ${shellQuote(manifest)} || test -f ${shellQuote(manifest)}`,
    `if [ -f ${shellQuote(manifest)} ]; then`,
    `  while IFS= read -r projection || [ -n "$projection" ]; do`,
    `    if ! grep -Fqx -- "$projection" ${shellQuote(next)}; then`,
    `      projection_path=$(printf '%s' "$projection" | base64 -d)`,
    `      projection_target=${shellQuote(`${persistent}/`)}$projection_path`,
    `      if [ -e "$projection_target" ] || [ -L "$projection_target" ]; then`,
    `        projection_parent=$(CDPATH= cd -P -- "$(dirname -- "$projection_target")" && pwd -P)`,
    `        case "$projection_parent" in`,
    `          ${shellQuote(persistent)}|${shellQuote(`${persistent}/`)}*) rm -rf -- "$projection_target" ;;`,
    `          *) printf '%s\n' 'Box projected path escapes writable state.' >&2; exit 1 ;;`,
    `        esac`,
    `      fi`,
    `    fi`,
    `  done < ${shellQuote(manifest)}`,
    `fi`,
    `mv -f -- ${shellQuote(next)} ${shellQuote(manifest)}`,
  );
}

async function findMissingState(
  options: CrabboxSessionOptions,
  leaseId: string,
  abortSignal: AbortSignal | undefined,
) {
  if (!options.plan.state.length) return new Set<number>();
  const result = await runCrabbox(options, leaseId, {
    abortSignal,
    command: options.plan.state
      .map((state, index) => {
        const path = shellQuote(remoteStatePath(options.stateRoot!, state.key));
        return `if [ -e ${path} ] || [ -L ${path} ]; then test -d ${path} || exit 1; else printf '%s\\n' ${shellQuote(String(index))}; fi`;
      })
      .join("; "),
  });
  if (result.exitCode !== 0) throw crabboxError("inspect Box state", result);
  return new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean).map(Number));
}

async function resolveFiles(files: Readonly<Record<string, ResolvedBoxFile>>) {
  return await Promise.all(
    Object.entries(files).map(async ([path, input]) => ({ contents: await input.resolve(), path })),
  );
}

function appendFiles(
  script: string[],
  root: string,
  files: readonly { contents: Uint8Array; path: string }[],
  cleanup: string[],
) {
  for (const file of files)
    appendFile(script, posix.join(root, file.path), file.contents, 0o600, cleanup);
}

function appendFile(
  script: string[],
  path: string,
  contents: Uint8Array,
  mode: number,
  cleanup: string[],
) {
  const temporary = `${path}.vitehub-${randomUUID()}`;
  const marker = `VITEHUB_${randomUUID().replaceAll("-", "")}`;
  cleanup.push(temporary);
  script.push(
    `mkdir -p -- ${shellQuote(posix.dirname(path))}`,
    `base64 -d > ${shellQuote(temporary)} <<'${marker}'`,
    Buffer.from(contents).toString("base64"),
    marker,
    `chmod ${mode.toString(8)} ${shellQuote(temporary)}`,
    `rm -rf -- ${shellQuote(path)}`,
    `mv -f -- ${shellQuote(temporary)} ${shellQuote(path)}`,
  );
}

function remoteStatePath(root: string, key: string) {
  return posix.join(root, createHash("sha256").update(key).digest("hex"));
}

async function acquireRemoteState(
  options: CrabboxSessionOptions,
  leaseId: string,
  abortSignal: AbortSignal | undefined,
): Promise<CrabboxStateLease> {
  const locks = [
    ...new Set(
      options.plan.state.map((state) => `${remoteStatePath(options.stateRoot!, state.key)}.lock`),
    ),
  ].sort();
  if (!locks.length) return emptyStateLease();

  const token = randomUUID();
  const marker = `VITEHUB_STATE_READY_${token}`;
  const owner = posix.join(options.stateRoot!, `.vitehub-owner-${token}`);
  const releaseCommands = locks.toReversed().map((lock) => {
    return `if [ "$(sed -n '2p' ${shellQuote(lock)} 2>/dev/null || true)" = ${shellQuote(token)} ]; then rm -f -- ${shellQuote(lock)}; fi`;
  });
  const script = [
    "set -eu",
    "umask 077",
    `mkdir -p -- ${shellQuote(options.stateRoot!)}`,
    `printf '%s\\n%s\\n' "$$" ${shellQuote(token)} > ${shellQuote(owner)}`,
    "release_vitehub_state() {",
    "  set +e",
    ...releaseCommands.map((command) => `  ${command}`),
    `  rm -f -- ${shellQuote(owner)}`,
    "}",
    "trap release_vitehub_state EXIT HUP INT TERM",
  ];
  for (const lock of locks) {
    script.push(
      `while ! ln -- ${shellQuote(owner)} ${shellQuote(lock)} 2>/dev/null; do`,
      `  lock_pid=$(sed -n '1p' ${shellQuote(lock)} 2>/dev/null || true)`,
      `  lock_token=$(sed -n '2p' ${shellQuote(lock)} 2>/dev/null || true)`,
      `  stale_lock=${shellQuote(`${lock}.stale-`)}"$lock_token"`,
      '  case "$lock_pid" in',
      "    ''|*[!0-9]*)",
      `      lock_time=$(stat -c %Y ${shellQuote(lock)} 2>/dev/null || date +%s)`,
      "      now=$(date +%s)",
      `      if [ $((now - lock_time)) -gt 5 ] && [ -n "$lock_token" ] && ln -- ${shellQuote(lock)} "$stale_lock" 2>/dev/null; then`,
      `        if [ "$(sed -n '2p' ${shellQuote(lock)} 2>/dev/null || true)" = "$lock_token" ]; then rm -f -- ${shellQuote(lock)}; fi`,
      "      fi",
      "      ;;",
      "    *)",
      `      if ! kill -0 "$lock_pid" 2>/dev/null && [ -n "$lock_token" ] && ln -- ${shellQuote(lock)} "$stale_lock" 2>/dev/null; then`,
      `        if [ "$(sed -n '2p' ${shellQuote(lock)} 2>/dev/null || true)" = "$lock_token" ]; then rm -f -- ${shellQuote(lock)}; fi`,
      "      fi",
      "      ;;",
      "  esac",
      "  sleep 0.05",
      "done",
    );
  }
  script.push(`printf '%s\\n' ${shellQuote(marker)}`, "IFS= read -r _ || true");

  const child = spawnCrabbox(options, runArgs(leaseId, script.join("\n"), true));
  let stderr = "";
  let output = "";
  let ready = false;
  let releasing = false;
  let failure: Error | undefined;
  const controller = new AbortController();
  let resolveReady = () => {};
  let rejectReady = (_error: unknown) => {};
  const readiness = new Promise<void>((resolvePromise, reject) => {
    resolveReady = resolvePromise;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk) => {
    if (!ready) output = `${output}${String(chunk)}`.slice(-marker.length * 2);
    if (!ready && output.includes(marker)) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    if (!ready) stderr = `${stderr}${String(chunk)}`.slice(-4_096);
  });
  const loseLease = (error: Error) => {
    if (releasing || failure) return;
    failure = error;
    controller.abort(error);
  };
  child.once("error", (error) => {
    if (ready) loseLease(new Error("[vitehub] Crabbox state lease was lost.", { cause: error }));
    else rejectReady(error);
  });
  const completion = new Promise<number>((resolvePromise) =>
    child.once("close", (code) => resolvePromise(code ?? 1)),
  );
  child.once("close", (code) => {
    if (!ready) {
      const detail = stderr.trim();
      rejectReady(
        new Error(
          `[vitehub] Failed to acquire Crabbox state lease${detail ? `: ${detail}` : code === 0 ? "." : ` (exit ${code ?? 1}).`}`,
        ),
      );
    } else if (!releasing) {
      loseLease(
        new Error(
          `[vitehub] Crabbox state lease was lost${code && code !== 0 ? ` (exit ${code}).` : "."}`,
        ),
      );
    }
  });
  const abort = () => {
    child.kill();
    rejectReady(abortSignal?.reason || new Error("Crabbox state lease aborted."));
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    abortSignal?.throwIfAborted();
    await readiness;
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await completion;
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", abort);
  }

  let released = false;
  return {
    assertActive() {
      if (failure) throw failure;
    },
    async release() {
      if (!released) {
        released = true;
        releasing = true;
        if (!child.stdin.destroyed) child.stdin.end();
      }
      const exitCode = await completion;
      if (failure) throw failure;
      if (exitCode !== 0)
        throw new Error(`[vitehub] Failed to release Crabbox state lease (exit ${exitCode}).`);
    },
    signal: controller.signal,
  };
}

function createCrabboxSession(state: CrabboxSessionState, sessionId: string | undefined): RuntimeSession {
  let destroyed = false;
  const session = {
    defaultWorkingDirectory: state.root,
    description: "Crabbox session.",
    id: sessionId || randomUUID(),
    ports: [0],
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      let failure: unknown
      try {
        await this.stop();
        state.stateLease.assertActive();
        const reclaim = await runCrabbox(state.options, state.leaseId, { command: reclaimDisposableRootProcessesCommand(state.root, state.statePaths) })
        if (reclaim.exitCode !== 0) throw crabboxError("reclaim disposable Box processes", reclaim)
        if (state.options.workspace) await syncWorkspaceBack(state)
      }
      catch (error) {
        failure = error
      }
      finally {
        let cleanupFailure: unknown
        const result = await runCrabbox(state.options, state.leaseId, { command: removeDisposableRootCommand(state.root) }).catch((error) => {
          cleanupFailure = error
          return undefined
        })
        await state.stateLease.release().catch((error) => (cleanupFailure ||= error));
        await rm(state.options.stateHome, { force: true, recursive: true }).catch(error => cleanupFailure ||= error)
        state.releaseWorkspace()
        if (!failure) failure = cleanupFailure || (result && result.exitCode !== 0 ? crabboxError("remove disposable Box cache", result) : undefined)
      }
      if (failure) throw failure
    },
    async getPortUrl({ port, protocol = "http" }: { port: number, protocol?: "http" | "https" | "ws" }) {
      if (state.options.network === "direct") return `${protocol}://127.0.0.1:${port}`
      const tunnel = state.tunnels.get(port) || startTunnel(state, port)
      return `${protocol}://127.0.0.1:${await tunnel.localPort}`
    },
    async existsFile({ abortSignal, path }: { abortSignal?: AbortSignal, path: string }) {
      const target = resolveSessionPath(state.root, path)
      const result = await this.run({
        abortSignal: stateAbortSignal(state, abortSignal),
        command: `test -e ${shellQuote(target)} || test -L ${shellQuote(target)}`,
      })
      return result.exitCode === 0
    },
    async listFiles({ abortSignal, path, recursive = false }: { abortSignal?: AbortSignal, path: string, recursive?: boolean }) {
      const target = resolveSessionPath(state.root, path)
      const command = [
        "find",
        shellQuote(target),
        "-mindepth 1",
        ...(recursive ? [] : ["-maxdepth 1"]),
        "-printf '%y\\t%s\\t%p\\0'",
      ].join(" ")
      const result = await this.run({ abortSignal: stateAbortSignal(state, abortSignal), command })
      if (result.exitCode !== 0) throw crabboxError(`list ${path}`, result)
      return result.stdout
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [kind, size, entryPath] = line.split("\t")
          if (!entryPath || !kind) throw new Error(`[vitehub] Crabbox returned an invalid file entry for ${path}.`)
          return {
            path: entryPath,
            size: kind === "f" ? Number(size) : undefined,
            type: kind === "d"
              ? "directory" as const
              : kind === "l"
                ? "symlink" as const
                : "file" as const,
          }
        })
        .sort((left, right) => left.path.localeCompare(right.path))
    },
    async makeDirectory({ abortSignal, path, recursive = false }: { abortSignal?: AbortSignal, path: string, recursive?: boolean }) {
      const target = resolveSessionPath(state.root, path)
      const result = await this.run({
        abortSignal: stateAbortSignal(state, abortSignal),
        command: `mkdir ${recursive ? "-p " : ""}-- ${shellQuote(target)}`,
      })
      if (result.exitCode !== 0) throw crabboxError(`create directory ${path}`, result)
    },
    async moveFile({ abortSignal, destination, source }: { abortSignal?: AbortSignal, destination: string, source: string }) {
      const target = resolveSessionPath(state.root, destination)
      const sourcePath = resolveSessionPath(state.root, source)
      const result = await this.run({
        abortSignal: stateAbortSignal(state, abortSignal),
        command: `mkdir -p -- ${shellQuote(posix.dirname(target))} && mv -- ${shellQuote(sourcePath)} ${shellQuote(target)}`,
      })
      if (result.exitCode !== 0) throw crabboxError(`move ${source}`, result)
    },
    async readBinaryFile({ abortSignal, path }: { abortSignal?: AbortSignal, path: string }) {
      const stateSignal = stateAbortSignal(state, abortSignal);
      const remotePath = resolveSessionPath(state.root, path)
      const probe = await this.run({ abortSignal: stateSignal,
        command: `if ! test -f ${shellQuote(remotePath)}; then exit 1; elif test -L ${shellQuote(remotePath)}; then exit 2; fi` })
      if (probe.exitCode === 1) return null
      if (probe.exitCode !== 0 && probe.exitCode !== 2) throw crabboxError(`read ${path}`, probe)
      const stagedPath = probe.exitCode === 2 ? posix.join(state.root, `.vitehub-read-${randomUUID()}`) : undefined
      try {
        if (stagedPath) {
          const staged = await this.run({ abortSignal: stateSignal,
            command: `cp -L -- ${shellQuote(remotePath)} ${shellQuote(stagedPath)}` })
          if (staged.exitCode !== 0) throw crabboxError(`read ${path}`, staged)
        }
        return await withTemporaryFile(async (localPath) => {
          await copyWithCrabbox(
            state.options,
            state.leaseId,
            `SANDBOX:${stagedPath || remotePath}`,
            localPath,
            stateSignal,
          )
          return new Uint8Array(await readFile(localPath))
        })
      }
      finally {
        if (stagedPath) await runCrabbox(state.options, state.leaseId, { command: `rm -f -- ${shellQuote(stagedPath)}` }).catch(() => undefined)
      }
    },
    async readFile(options: { abortSignal?: AbortSignal, path: string }) {
      const bytes = await this.readBinaryFile(options)
      return bytes ? readableStream(bytes) : null
    },
    async readTextFile({ abortSignal, encoding = "utf8", endLine, path, startLine }: { abortSignal?: AbortSignal, encoding?: string, endLine?: number, path: string, startLine?: number }) {
      const bytes = await this.readBinaryFile({ abortSignal, path })
      if (!bytes) return null
      const text = Buffer.from(bytes).toString(encoding as BufferEncoding)
      if (startLine === undefined && endLine === undefined) return text
      return text.split(/\r?\n/).slice((startLine || 1) - 1, endLine).join("\n")
    },
    restricted() {
      return this
    },
    async run(runOptions: CrabboxRunOptions) {
      const child = spawnCrabboxRun(state, runOptions)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.wait(),
      ])
      return { exitCode, stderr, stdout }
    },
    async spawn(runOptions: CrabboxRunOptions) {
      return spawnCrabboxRun(state, runOptions)
    },
    async stop() {
      for (const { child } of state.tunnels.values()) child.kill()
      for (const child of state.processes) child.kill()
      await Promise.all([
        ...[...state.tunnels.values()].map(({ child }) => waitForExit(child)),
        ...[...state.processes].map(child => waitForExit(child)),
      ])
      state.tunnels.clear()
      state.processes.clear()
    },
    async removeFile({ abortSignal, path, recursive = false }: { abortSignal?: AbortSignal, path: string, recursive?: boolean }) {
      const target = resolveSessionPath(state.root, path)
      const result = await this.run({
        abortSignal: stateAbortSignal(state, abortSignal),
        command: recursive
          ? `rm -rf -- ${shellQuote(target)}`
          : `if test -d ${shellQuote(target)} && ! test -L ${shellQuote(target)}; then rmdir -- ${shellQuote(target)}; else rm -f -- ${shellQuote(target)}; fi`,
      })
      if (result.exitCode !== 0) throw crabboxError(`remove ${path}`, result)
    },
    async writeBinaryFile({ abortSignal, content, path }: { abortSignal?: AbortSignal, content: Uint8Array, path: string }) {
      const stateSignal = stateAbortSignal(state, abortSignal);
      const remotePath = resolveSessionPath(state.root, path)
      const directory = posix.dirname(remotePath)
      const prepared = await this.run({ abortSignal: stateSignal,
        command: `mkdir -p -- ${shellQuote(directory)} && test ! -d ${shellQuote(remotePath)}` })
      if (prepared.exitCode !== 0) throw crabboxError(`prepare ${path}`, prepared)
      const stagedPath = posix.join(state.root, `.vitehub-write-${randomUUID()}`)
      try {
        await withTemporaryFile(async (localPath) => {
          await writeFile(localPath, content)
          await copyWithCrabbox(
            state.options,
            state.leaseId,
            localPath,
            `SANDBOX:${stagedPath}`,
            stateSignal,
          )
        })
        const written = await this.run({ abortSignal: stateSignal,
          command: `cat -- ${shellQuote(stagedPath)} > ${shellQuote(remotePath)}` })
        if (written.exitCode !== 0) throw crabboxError(`write ${path}`, written)
      }
      finally {
        await runCrabbox(state.options, state.leaseId, { command: `rm -f -- ${shellQuote(stagedPath)}` }).catch(() => undefined)
      }
    },
    async writeFile({ abortSignal, content, path }: { abortSignal?: AbortSignal, content: ReadableStream<Uint8Array>, path: string }) {
      await this.writeBinaryFile({ abortSignal, content: await bytesFromStream(content), path })
    },
    async writeTextFile({ abortSignal, content, encoding = "utf8", path }: { abortSignal?: AbortSignal, content: string, encoding?: string, path: string }) {
      await this.writeBinaryFile({ abortSignal, content: Buffer.from(content, encoding as BufferEncoding), path })
    },
  } satisfies RuntimeSession
  return session
}

function removeDisposableRootCommand(root: string, statePaths: readonly string[] = []) {
  return `${reclaimDisposableRootProcessesCommand(root, statePaths)}; chmod -R u+w -- ${shellQuote(root)} 2>/dev/null || true; rm -rf -- ${shellQuote(root)}`
}

function reclaimDisposableRootProcessesCommand(root: string, statePaths: readonly string[] = []) {
  const referencesBox = [root, ...statePaths].map(path => `references_box_path "$1" ${shellQuote(path)}`).join(" || ")
  return `owner_uid=$(id -u); references_box_path() { pid=$1; root=$2; cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true); case "$cwd" in "$root"|"$root"/*) return 0 ;; esac; for fd in /proc/$pid/fd/*; do target=$(readlink "$fd" 2>/dev/null || true); case "$target" in "$root"|"$root"/*) return 0 ;; esac; done; awk -v root="$root" 'BEGIN { RS="\\0" } { value=$0; offset=1; while ((position=index(substr(value, offset), root)) != 0) { position += offset - 1; before=position == 1 ? "" : substr(value, position - 1, 1); after=substr(value, position + length(root), 1); if ((position == 1 || before !~ /[A-Za-z0-9_.\\/-]/) && (after == "" || after == "/")) { found=1; break } offset=position + 1 } } END { exit found ? 0 : 1 }' "/proc/$pid/cmdline" "/proc/$pid/environ" 2>/dev/null; }; references_box() { ${referencesBox}; }; owns_box_process() { pid=$1; status=/proc/$pid/status; test -r "$status" || return 1; ppid=; uid=; while IFS=: read -r key value; do case "$key" in PPid) set -- $value; ppid=$1 ;; Uid) set -- $value; uid=$1 ;; esac; done < "$status"; test "$ppid" = 1 && test "$uid" = "$owner_uid" && references_box "$pid"; }; passes=0; while :; do pids=; for status in /proc/[0-9]*/status; do pid=\${status#/proc/}; pid=\${pid%/status}; if owns_box_process "$pid"; then pids="$pids $pid"; kill -TERM "$pid" 2>/dev/null || true; fi; done; test -n "$pids" || break; passes=$((passes + 1)); test "$passes" -le 32 || exit 1; sleep 1; for pid in $pids; do owns_box_process "$pid" && kill -KILL "$pid" 2>/dev/null || true; done; done`
}

async function warmup(options: CrabboxSessionOptions, abortSignal: AbortSignal | undefined) {
  const result = await runProcess(spawnCrabbox(options, [
    "warmup",
    "--provider", "ssh",
    "--target", "linux",
    ...(options.reclaim ? ["--reclaim"] : []),
    "--timing-json",
  ], abortSignal, options.workspace))
  if (result.exitCode !== 0) throw crabboxError("warm Crabbox", result)
  const timing = result.stderr.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith("{"))
  try {
    const leaseId = timing && (JSON.parse(timing) as { leaseId?: unknown }).leaseId
    if (typeof leaseId === "string" && leaseId) return leaseId
  }
  catch {}
  throw new Error("[vitehub] Crabbox warmup did not return a lease id.")
}

function spawnCrabboxRun(state: CrabboxSessionState, options: CrabboxRunOptions) {
  const abortSignal = stateAbortSignal(state, options.abortSignal);
  const workingDirectory = resolveSessionPath(state.root, options.workingDirectory)
  const command = shellCommand(options.command, workingDirectory, options.env,
    state.environmentFile,
  );
  const child = spawnCrabbox(state.options, runArgs(state.leaseId, command, options.sync !== true),
    abortSignal, options.localWorkingDirectory)
  state.processes.add(child)
  child.once("close", () => state.processes.delete(child))
  return processHandle(child, abortSignal)
}

async function runCrabbox(options: CrabboxSessionOptions, leaseId: string, run: CrabboxRunOptions) {
  const command = shellCommand(run.command, undefined, run.env)
  return await runProcess(spawnCrabbox(options, runArgs(leaseId, command, run.sync !== true), run.abortSignal, run.localWorkingDirectory))
}

function runArgs(leaseId: string, command: string, noSync: boolean) {
  return [
    "run",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
    "--no-hydrate",
    ...(noSync ? ["--no-sync"] : []),
    "--shell", command,
  ]
}

async function runCrabboxScript(options: CrabboxSessionOptions, leaseId: string, run: { abortSignal?: AbortSignal, script: string }) {
  const child = spawnCrabbox(options, [
    "run",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
    "--no-hydrate",
    "--no-sync",
    "--script-stdin",
  ], run.abortSignal)
  child.stdin.end(run.script)
  const result = await runProcess(child)
  if (result.exitCode !== 0) throw crabboxError("run Crabbox script", result)
  return result
}

async function copyWithCrabbox(
  options: CrabboxSessionOptions,
  leaseId: string,
  source: string,
  destination: string,
  abortSignal: AbortSignal | undefined,
) {
  const result = await runProcess(spawnCrabbox(options, [
    "cp",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
    source,
    destination,
  ], abortSignal))
  if (result.exitCode !== 0) throw crabboxError(`copy ${source}`, result)
}

function startTunnel(state: CrabboxSessionState, remotePort: number) {
  const child = spawnCrabbox(state.options, [
    "tunnel",
    "--provider", "ssh",
    "--target", "linux",
    "--id", state.leaseId,
    String(remotePort),
  ], stateAbortSignal(state))
  child.on("error", () => undefined)
  let stderr = ""
  const captureStderr = (chunk: Buffer | string) => stderr = `${stderr}${String(chunk)}`.slice(-4_096)
  child.stderr.on("data", captureStderr)
  const tunnel: CrabboxTunnel = {
    child,
    localPort: firstLine(child.stdout, child).then((line) => {
      const url = new URL(line)
      const localPort = Number(url.port)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
        throw new Error("Crabbox returned an invalid tunnel URL.")
      }
      return localPort
    }).catch(async (cause) => {
      child.kill()
      await waitForExit(child)
      const detail = stderr.trim()
      throw new Error(`[vitehub] Crabbox tunnel failed${detail ? `: ${detail}` : "."}`, { cause })
    }).finally(() => child.stderr.off("data", captureStderr)),
  }
  state.tunnels.set(remotePort, tunnel)
  child.once("close", () => {
    if (state.tunnels.get(remotePort) === tunnel) state.tunnels.delete(remotePort)
  })
  return tunnel
}

async function validateRequirements(
  session: RuntimeSession,
  requirements: readonly ResolvedBoxRequirementInput[],
  abortSignal: AbortSignal | undefined,
  secrets: readonly string[],
  includeDiagnosticOutput: boolean,
) {
  for (const requirement of requirements) {
    const command = ["command -v", shellQuote(requirement.command), ">/dev/null"]
    if (requirement.args.length) command.push("&&", shellQuote(requirement.command), ...requirement.args.map(shellQuote))
    let result: Awaited<ReturnType<RuntimeSession["run"]>>
    try {
      result = await session.run({
        abortSignal: boxRequirementSignal(requirement, abortSignal),
        command: command.join(" "),
        workingDirectory: posix.join(session.defaultWorkingDirectory, "workspace"),
      })
    }
    catch (cause) {
      if (abortSignal?.aborted) throw abortSignal.reason
      throw boxRequirementError(
        requirement,
        cause,
        secrets,
        requirement.timeout,
        includeDiagnosticOutput,
      )
    }
    if (result.exitCode !== 0) {
      throw boxRequirementError(
        requirement,
        result,
        secrets,
        requirement.timeout,
        includeDiagnosticOutput,
      )
    }
  }
}

function spawnCrabbox(options: CrabboxSessionOptions, args: string[], abortSignal?: AbortSignal, cwd = options.workspace) {
  return spawnChildProcess("crabbox", args, {
    cwd,
    env: {
      ...process.env,
      XDG_STATE_HOME: options.stateHome,
      ...(options.profile ? { CRABBOX_PROFILE: options.profile } : {}),
    },
    signal: abortSignal,
  })
}

function processHandle(child: ChildProcessWithoutNullStreams, abortSignal: AbortSignal | undefined) {
  let abortReason: unknown
  const abort = () => abortReason = abortSignal?.reason || new Error("Crabbox command aborted.")
  abortSignal?.addEventListener("abort", abort, { once: true })
  const wait = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      abortSignal?.removeEventListener("abort", abort)
      if (abortReason) reject(abortReason)
      else resolvePromise({ exitCode: code ?? 1 })
    })
  })
  return {
    pid: child.pid,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    wait: () => wait,
    async kill() {
      child.kill()
      await wait.catch(() => undefined)
    },
  }
}

function emptyStateLease(): CrabboxStateLease {
  return {
    assertActive() {},
    async release() {},
    signal: new AbortController().signal,
  };
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  return active.length ? AbortSignal.any(active) : undefined;
}

function stateAbortSignal(state: CrabboxSessionState, signal?: AbortSignal) {
  state.stateLease.assertActive();
  return combineAbortSignals(signal, state.stateLease.signal);
}

async function runProcess(child: ChildProcessWithoutNullStreams) {
  const handle = processHandle(child, undefined)
  const [stdout, stderr, { exitCode }] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.wait()])
  return { exitCode, stderr, stdout }
}

function shellCommand(command: string, workingDirectory: string | undefined, env: Record<string, string> | undefined,
  environmentFile?: string,
) {
  const parts = []
  if (workingDirectory) parts.push(`cd -P -- ${shellQuote(workingDirectory)}`)
  const names = Object.keys(env || {})
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`[vitehub] Invalid Box environment variable: ${name}`);
    if (runtimeEnvironmentKeys.has(name))
      throw new Error(`[vitehub] Box commands cannot override ${name}.`);
  }
  const run = names.length
    ? `env ${names.map(name => `${name}=${shellQuote(env![name])}`).join(" ")} sh -c ${shellQuote(command)}`
    : command
  parts.push(run);
  const script = parts.join(" && ");
  return environmentFile ? `${shellQuote(environmentFile)} sh -c ${shellQuote(script)}` : script;
}

function resolveSessionPath(root: string, path = "") {
  const normalizedRoot = posix.normalize(root)
  const candidate = posix.isAbsolute(path)
    ? path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
      ? posix.normalize(path)
      : posix.join(normalizedRoot, path.replace(/^\/+/, ""))
    : posix.join(normalizedRoot, path)
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`[vitehub] Crabbox path escapes the session root: ${path}`)
  }
  return candidate
}

function remotePathsOverlap(first: string, second: string) {
  const normalizedFirst = posix.normalize(first);
  const normalizedSecond = posix.normalize(second);
  return (
    normalizedFirst === normalizedSecond ||
    isRemoteDescendant(normalizedFirst, normalizedSecond) ||
    isRemoteDescendant(normalizedSecond, normalizedFirst)
  );
}

function isRemoteDescendant(path: string, parent: string) {
  return path.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function readableStream(bytes: Uint8Array) {
  return new Response(bytes).body!
}

async function bytesFromStream(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return await new Response(stream).text()
}

async function withTemporaryFile<T>(run: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-box-"))
  try {
    return await run(join(directory, "file"))
  }
  finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function acquireWorkspace(workspace: string, abortSignal?: AbortSignal) {
  abortSignal?.throwIfAborted()
  const previous = workspaceSessions.get(workspace) || Promise.resolve()
  let unlock = () => {}
  const gate = new Promise<void>(resolve => unlock = resolve)
  const current = previous.catch(() => undefined).then(() => gate)
  workspaceSessions.set(workspace, current)
  let rejectAbort = (_reason?: unknown) => {}
  const onAbort = () => rejectAbort(abortSignal?.reason)
  try {
    await Promise.race([
      previous.catch(() => undefined),
      new Promise<never>((_, reject) => {
        rejectAbort = reject
        abortSignal?.addEventListener("abort", onAbort, { once: true })
      }),
    ])
    abortSignal?.throwIfAborted()
  }
  catch (error) {
    unlock()
    void current.finally(() => {
      if (workspaceSessions.get(workspace) === current) workspaceSessions.delete(workspace)
    })
    throw error
  }
  finally {
    abortSignal?.removeEventListener("abort", onAbort)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    unlock()
    void current.finally(() => {
      if (workspaceSessions.get(workspace) === current) workspaceSessions.delete(workspace)
    })
  }
}

async function syncWorkspaceBack(state: CrabboxSessionState) {
  const workspace = state.options.workspace
  if (!workspace) return
  const abortSignal = stateAbortSignal(state);
  const initialManifest = Buffer.from(state.syncedWorkspacePaths.map(path => `${path}\0`).join("")).toString("base64")
  const result = await runCrabboxScript(state.options, state.leaseId, {
    abortSignal,
    script: `temporary=$(mktemp -d /tmp/vitehub-workspace.XXXXXX) && archive="$temporary/workspace.tar" && manifest="$temporary/manifest" && existing_manifest="$temporary/existing-manifest" && ignore_failed_read=$(tar --ignore-failed-read -cf /dev/null -T /dev/null >/dev/null 2>&1 && printf %s --ignore-failed-read || true) && trap 'rm -rf -- "$temporary"' EXIT && if git -C ${shellQuote(state.remoteWorkspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf %s ${shellQuote(initialManifest)} | base64 -d > "$manifest" && git -C ${shellQuote(state.remoteWorkspace)} ls-files -z --cached --others --exclude-standard >> "$manifest" && (cd ${shellQuote(state.remoteWorkspace)} && xargs -0 sh -c 'for path do if test -e "$path" || test -L "$path"; then printf "%s\\0" "$path"; fi; done' sh < "$manifest") > "$existing_manifest" && tar $ignore_failed_read --no-recursion --null -C ${shellQuote(state.remoteWorkspace)} -cf "$archive" -T "$existing_manifest"; else tar -C ${shellQuote(state.remoteWorkspace)} --exclude ./.git --exclude .git -cf "$archive" .; fi && base64 < "$archive"`,
  })
  const archive = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")
  const transactionRoot = await mkdtemp(join(dirname(workspace), ".vitehub-workspace-"))
  const stagedWorkspace = join(transactionRoot, "workspace")
  const backupWorkspace = join(transactionRoot, "backup")
  await withTemporaryFile(async (localPath) => {
    try {
      await writeFile(localPath, archive)
      await cp(workspace, stagedWorkspace, { recursive: true })
      await rejectSymlinkedArchiveParents(stagedWorkspace, localPath)
      await pruneWorkspaceForArchive(stagedWorkspace, localPath, state.syncedWorkspacePaths)
      const extract = await runProcess(spawnChildProcess("tar", ["--no-same-owner", "--no-same-permissions", "-xf", localPath, "-C", stagedWorkspace]))
      if (extract.exitCode !== 0) throw crabboxError("extract Crabbox workspace", extract)
      await rename(workspace, backupWorkspace)
      try {
        await rename(stagedWorkspace, workspace)
      }
      catch (error) {
        await rename(backupWorkspace, workspace)
        throw error
      }
    }
    finally {
      await rm(transactionRoot, { force: true, recursive: true })
    }
  })
}

async function listRemoteWorkspacePaths(options: CrabboxSessionOptions, leaseId: string, workspace: string,
  abortSignal?: AbortSignal,
) {
  const result = await runCrabbox(options, leaseId, {
    abortSignal,
    command: `if git -C ${shellQuote(workspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -C ${shellQuote(workspace)} ls-files -z --cached --others --exclude-standard; else cd ${shellQuote(workspace)} && find . -mindepth 1 \\( -name .git -o -path '*/.git/*' \\) -prune -o \\( -type d -o -type f -o -type l \\) -exec printf '%s\\0' {} +; fi`,
  })
  if (result.exitCode !== 0) throw crabboxError("inspect Crabbox workspace", result)
  const paths = result.stdout
    .split("\0")
    .map(path => normalizeRelativeArchivePath(path))
    .filter((path): path is string => Boolean(path))
  return [...new Set(paths.flatMap((path) => {
    const parts = path.split("/")
    return [path, ...parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"))]
  }))]
}

export async function rejectSymlinkedArchiveParents(workspace: string, archivePath: string): Promise<void> {
  await rejectSymlinkedParents(workspace, (await listArchiveEntries(archivePath)).map(entry => entry.path))
}

async function rejectSymlinkedParents(workspace: string, entries: readonly string[]) {
  const checked = new Set<string>()
  for (const entry of entries) {
    const parts = entry.split("/")
    for (let length = 1; length < parts.length; length++) {
      const path = parts.slice(0, length).join("/")
      if (checked.has(path)) continue
      checked.add(path)
      const item = await lstat(join(workspace, path)).catch(() => undefined)
      if (item?.isSymbolicLink()) throw new Error(`[vitehub] Crabbox workspace archive conflicts with local symlink: ${path}`)
    }
  }
}

export async function pruneWorkspaceForArchive(workspace: string, archivePath: string, manifest: readonly string[]): Promise<void> {
  if (!manifest.length) return
  const archive = await listArchiveEntries(archivePath)
  const archived = new Map(archive.map(entry => [entry.path, entry.directory]))
  const removed = (await Promise.all(manifest.map(async (path) => {
    const archivedDirectory = archived.get(path)
    if (archivedDirectory === undefined) return path
    const item = await lstat(join(workspace, path)).catch(() => undefined)
    return item && item.isDirectory() !== archivedDirectory ? path : undefined
  }))).filter((path): path is string => Boolean(path))
  await rejectSymlinkedParents(workspace, removed)
  await Promise.all(removed.map(async (path) => {
    await rm(join(workspace, path), { force: true, recursive: true })
  }))
  const parents = [...new Set(removed.flatMap((path) => {
    const parts = path.split("/")
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"))
  }))].sort((a, b) => b.length - a.length)
  for (const path of parents) {
    await rmdir(join(workspace, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error
    })
  }
}

async function listArchiveEntries(archivePath: string) {
  const result = await runProcess(spawnChildProcess("tar", ["-tf", archivePath]))
  if (result.exitCode !== 0) throw crabboxError("inspect Crabbox workspace", result)
  return result.stdout.split(/\r?\n/).flatMap((path) => {
    if (!path) return []
    const normalized = normalizeRelativeArchivePath(path)
    if (!normalized && path !== "." && path !== "./") {
      throw new Error(`[vitehub] Crabbox workspace archive contains an invalid path: ${path}`)
    }
    return normalized ? [{ directory: path.endsWith("/"), path: normalized }] : []
  })
}

function normalizeRelativeArchivePath(path: string) {
  const normalized = posix.normalize(path.replace(/^\.\//, "").replace(/\/$/, ""))
  if (!normalized || normalized === "." || normalized.startsWith("../") || posix.isAbsolute(normalized)) return undefined
  return normalized
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function lastLines(value: string, count: number) {
  return value.trim().split(/\r?\n/).slice(-count)
}

function crabboxError(action: string, result: { stderr: string, stdout: string }) {
  const detail = result.stderr.trim() || result.stdout.trim()
  return new Error(`[vitehub] Failed to ${action}${detail ? `: ${detail}` : "."}`)
}

function firstLine(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let value = ""
    const data = (chunk: Buffer | string) => {
      value += chunk.toString()
      const index = value.indexOf("\n")
      if (index < 0) return
      cleanup()
      resolvePromise(value.slice(0, index))
    }
    const close = () => {
      cleanup()
      reject(new Error("[vitehub] Crabbox tunnel exited before readiness."))
    }
    const error = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const cleanup = () => {
      stream.off("data", data)
      child.off("close", close)
      child.off("error", error)
    }
    stream.on("data", data)
    child.once("close", close)
    child.once("error", error)
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolvePromise => child.once("close", () => resolvePromise()))
}

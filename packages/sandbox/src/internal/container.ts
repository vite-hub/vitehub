import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionAuthority } from "@vite-hub/runtime";

import type { SandboxRuntime, SandboxRuntimeInput } from "../index.ts";
import { sandboxErrorDiagnostics } from "../error-diagnostics.ts";
import { containerBrokerAddon, containerBrokerCaPath, containerBrokerEntrypoint } from "./container-broker.ts";
import { listCommandFiles } from "./file-listing.ts";
import { openRemoteSandbox, remoteSandboxPlan, resolveRemoteEnvironment } from "./remote.ts";
import { markBuiltInSandboxRuntime } from "./runtime.ts";
import type { RuntimeProcess, RuntimeSession } from "./session.ts";
import { shellQuote } from "./shell-quote.ts";

/** A credential that stays on the ViteHub host. The Sandbox sees only a placeholder. */
export interface ContainerSandboxCredential {
  /** Hosts that receive the real value, such as `api.github.com` or `*.example.com:8443`. */
  hosts: readonly string[];
  /** The real value. Resolved on the ViteHub host each time a session opens. */
  value: string | (() => string | Promise<string>);
}

/**
 * Egress for a container Sandbox.
 * - `"none"`: no network exit. This is the default.
 * - `{ allow }`: only the listed hosts and the credential hosts, through the broker.
 * - `"open"`: every host, through the broker.
 */
export type ContainerSandboxEgress = "none" | "open" | { allow: readonly string[] };

/** Requires rootful Docker Engine 28 or newer on native Linux, through a local or remote Docker context. */
export interface ContainerSandboxOptions {
  /** Image for the Sandbox container. It must have `sh`, coreutils, and GNU `find`, and `git` for a checkout. */
  image: string;
  /** Image for the broker. Defaults to a pinned `mitmproxy/mitmproxy` release. */
  brokerImage?: string;
  /** CPU limit, as for `docker run --cpus`. */
  cpus?: number;
  /**
   * Credentials keyed by the environment variable name in the Sandbox.
   * The broker replaces the placeholder with the real value in HTTPS request headers to the listed hosts only.
   */
  credentials?: Readonly<Record<string, ContainerSandboxCredential>>;
  /** Docker CLI command. Defaults to `docker`. The CLI uses the host Docker context. */
  docker?: string;
  egress?: ContainerSandboxEgress;
  /** Memory limit in bytes, as for `docker run --memory`. */
  memoryBytes?: number;
  /** Process limit, as for `docker run --pids-limit`. Defaults to 4096. */
  pidsLimit?: number;
  /** Container user, as for `docker run --user`. Defaults to the image user. */
  user?: string;
}

const defaultContainerBrokerImage = "mitmproxy/mitmproxy:12.2.3";

const brokerAlias = "vitehub-broker";
const brokerPort = 8080;
const sandboxRoot = "/vitehub";
const sandboxHome = `${sandboxRoot}/home`;
const sandboxWorkspace = `${sandboxRoot}/workspace`;
const brokerCaTarget = `${sandboxRoot}/broker-ca.pem`;
const pidDirectory = `${sandboxRoot}/.pids`;
const hostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedCredentialNames = new Set([
  "ALL_PROXY",
  "CODEX_HOME",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "INIT_CWD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PWD",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);
/** Names that the Docker CLI reads itself. Their Sandbox values travel on the command line instead of the CLI environment. */
const cliEnvironment = (name: string) => name === "PATH" || name === "HOME" || name.startsWith("DOCKER_") || name.startsWith("XDG_");

interface NormalizedContainerOptions {
  readonly brokerImage: string;
  readonly cpus?: number;
  readonly credentials: readonly { readonly hosts: readonly string[]; readonly name: string; readonly value: ContainerSandboxCredential["value"] }[];
  readonly docker: string;
  readonly egress: { readonly allow: readonly string[]; readonly policy: "allowlist" | "none" | "open" };
  readonly image: string;
  readonly memoryBytes?: number;
  readonly pidsLimit: number;
  readonly user?: string;
}

export function createContainerRuntime(options: ContainerSandboxOptions): SandboxRuntime {
  const normalized = normalizeContainerOptions(options);
  const executionAuthority = containerExecutionAuthority(normalized);
  return markBuiltInSandboxRuntime({
    name: "container",
    async prepare(input) {
      assertCredentialNames(input, normalized);
      return remoteSandboxPlan(input, { executionAuthority, runtime: "container" });
    },
    async open(input, openOptions) {
      assertCredentialNames(input, normalized);
      openOptions.signal?.throwIfAborted();
      const env = await resolveRemoteEnvironment(input, { home: sandboxHome, workspace: sandboxWorkspace });
      const runtimeSession = await startContainer(normalized, env, openOptions.id ?? `vitehub-${randomUUID()}`, openOptions.signal);
      return await openRemoteSandbox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        home: sandboxHome,
        initialize: openOptions.initialize,
        runtime: "container",
        signal: openOptions.signal,
        workspace: sandboxWorkspace,
      }, env);
    },
  });
}

function containerExecutionAuthority(options: NormalizedContainerOptions): ExecutionAuthority {
  return {
    credentials: options.credentials.length ? "provisioned" : "unknown",
    environment: "selected",
    filesystem: { access: "read-write", scope: "sandbox" },
    isolation: "container",
    network: options.egress.policy === "none" ? "none" : options.egress.policy === "open" ? "unrestricted" : "restricted",
    processes: "arbitrary",
  };
}

function normalizeContainerOptions(options: ContainerSandboxOptions): NormalizedContainerOptions {
  if (!options || typeof options !== "object")
    throw invalid("The container Sandbox runtime requires options with an image.");
  const image = requireText(options.image, "image");
  const brokerImage = options.brokerImage === undefined ? defaultContainerBrokerImage : requireText(options.brokerImage, "brokerImage");
  const docker = options.docker === undefined ? "docker" : requireText(options.docker, "docker");
  const user = options.user === undefined ? undefined : requireText(options.user, "user");
  const cpus = options.cpus;
  if (cpus !== undefined && (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0))
    throw invalid("Container Sandbox cpus must be a positive number.");
  const memoryBytes = options.memoryBytes;
  if (memoryBytes !== undefined && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 6 * 1024 * 1024))
    throw invalid("Container Sandbox memoryBytes must be a safe integer of at least 6 MiB.");
  const pidsLimit = options.pidsLimit ?? 4096;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit <= 0)
    throw invalid("Container Sandbox pidsLimit must be a positive integer.");

  const egress = normalizeEgress(options.egress);
  const credentialEntries = Object.entries(options.credentials ?? {});
  if (options.credentials !== undefined && (typeof options.credentials !== "object" || options.credentials === null || Array.isArray(options.credentials)))
    throw invalid("Container Sandbox credentials must be an object keyed by environment variable name.");
  if (credentialEntries.length && egress.policy === "none")
    throw invalid("Container Sandbox credentials need egress. Set egress to { allow: [...] } or \"open\".");
  const credentials = credentialEntries.map(([name, credential]) => {
    if (!environmentName.test(name))
      throw invalid(`Invalid container Sandbox credential name: ${name}`);
    if (reservedCredentialNames.has(name))
      throw invalid(`${name} is managed by the container Sandbox runtime.`);
    if (!credential || typeof credential !== "object" || !Array.isArray(credential.hosts) || credential.hosts.length === 0)
      throw invalid(`Container Sandbox credential ${name} requires at least one host.`);
    if (typeof credential.value !== "string" && typeof credential.value !== "function")
      throw invalid(`Container Sandbox credential ${name} requires a value or a value function.`);
    return Object.freeze({ hosts: Object.freeze(credential.hosts.map(host => normalizeHost(host, `credential ${name} host`))), name, value: credential.value });
  });

  return Object.freeze({
    brokerImage,
    ...(cpus === undefined ? {} : { cpus }),
    credentials: Object.freeze(credentials),
    docker,
    egress,
    image,
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    pidsLimit,
    ...(user === undefined ? {} : { user }),
  });
}

function normalizeEgress(egress: ContainerSandboxEgress | undefined): NormalizedContainerOptions["egress"] {
  if (egress === undefined || egress === "none") return Object.freeze({ allow: Object.freeze([]), policy: "none" as const });
  if (egress === "open") return Object.freeze({ allow: Object.freeze([]), policy: "open" as const });
  if (!egress || typeof egress !== "object" || !Array.isArray(egress.allow))
    throw invalid("Container Sandbox egress must be \"none\", \"open\", or { allow: [...] }.");
  return Object.freeze({
    allow: Object.freeze(egress.allow.map(host => normalizeHost(host, "egress host"))),
    policy: "allowlist" as const,
  });
}

function normalizeHost(value: unknown, label: string) {
  if (typeof value !== "string") throw invalid(`Container Sandbox ${label} must be a string.`);
  const host = value.trim().toLowerCase();
  const port = host.includes(":") ? Number(host.slice(host.lastIndexOf(":") + 1)) : 443;
  if (!hostPattern.test(host) || port < 1 || port > 65_535)
    throw invalid(`Container Sandbox ${label} must be a host name, *.host name, or either with :port: ${value}`);
  return host;
}

function requireText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw invalid(`Container Sandbox ${label} must be a non-empty string.`);
  return value.trim();
}

function assertCredentialNames(input: SandboxRuntimeInput, options: NormalizedContainerOptions) {
  for (const credential of options.credentials) {
    if (Object.hasOwn(input.plan.env, credential.name))
      throw invalid(`Container Sandbox credential ${credential.name} is also declared in sandbox.env. Declare it in one place.`);
  }
}

function invalid(message: string) {
  return sandboxErrorDiagnostics.SANDBOX_R0160({ message: `[vitehub] ${message}` });
}

/** Docker object names allow [a-zA-Z0-9][a-zA-Z0-9_.-]. */
function dockerName(id: string) {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 40);
  return `vitehub-sandbox-${safe || "session"}-${randomBytes(4).toString("hex")}`;
}

async function startContainer(
  options: NormalizedContainerOptions,
  env: Record<string, string>,
  id: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeSession> {
  const name = dockerName(id);
  const network = `${name}-net`;
  const broker = `${name}-broker`;
  const label = `dev.vitehub.sandbox=${name}`;
  const docker = (args: readonly string[], run: Omit<DockerRunOptions, "docker"> = {}) => dockerCommand({ docker: options.docker, ...run }, args);
  const created: { containers: string[]; network?: string } = { containers: [] };
  const cleanup = async () => {
    const failures: string[] = [];
    if (created.containers.length) {
      const result = await docker(["rm", "-f", ...created.containers]);
      if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) failures.push(result.stderr.trim());
    }
    if (created.network) {
      const result = await docker(["network", "rm", created.network]);
      if (result.exitCode !== 0 && !/not found|No such network/i.test(result.stderr)) failures.push(result.stderr.trim());
    }
    if (failures.length)
      throw sandboxErrorDiagnostics.SANDBOX_R0162({ message: `[vitehub] Container Sandbox cleanup failed: ${failures.join("; ")}` });
  };

  try {
    // Older Docker releases can silently ignore unknown bridge options.
    const version = await required(docker(["version", "--format", "{{.Server.Version}}"], { signal }), "check the Docker daemon version");
    const major = /^v?(\d+)\./.exec(version.stdout.trim());
    if (!major || Number(major[1]) < 28)
      throw invalid("Container Sandbox requires Docker Engine 28 or newer for isolated bridge gateway mode.");
    const details = await required(docker(["info", "--format", "{{json .}}"], { signal }), "check the Docker daemon platform");
    const unsupportedPlatform = () => invalid("Container Sandbox requires rootful Docker Engine on native Linux. Docker Desktop, OrbStack, WSL, and rootless Docker are not supported because their host routes bypass isolated bridge gateway mode.");
    let platform: { OSType?: unknown; OperatingSystem?: unknown; KernelVersion?: unknown; SecurityOptions?: unknown };
    try {
      platform = JSON.parse(details.stdout);
    } catch {
      throw unsupportedPlatform();
    }
    // Check the daemon rather than the CLI host so remote native Linux contexts work.
    // VM host aliases and rootless networking can bypass Moby's isolated bridge.
    if (!platform || platform.OSType !== "linux"
      || typeof platform.OperatingSystem !== "string" || !platform.OperatingSystem.trim()
      || typeof platform.KernelVersion !== "string" || !platform.KernelVersion.trim()
      || /docker desktop|orbstack|rancher desktop|colima|linuxkit/i.test(`${platform.OperatingSystem} ${platform.KernelVersion}`)
      || /microsoft|wsl/i.test(platform.KernelVersion)
      || !Array.isArray(platform.SecurityOptions)
      || platform.SecurityOptions.some(option => typeof option !== "string" || /rootless/i.test(option)))
      throw unsupportedPlatform();
    // An internal bridge normally still exposes host services at its gateway. Isolated
    // gateway mode leaves the host bridge without an address.
    await required(docker([
      "network", "create", "--internal",
      "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "--opt", "com.docker.network.bridge.gateway_mode_ipv6=isolated",
      "--label", label, network,
    ], { signal }), "create the Sandbox network");
    created.network = network;

    if (options.egress.policy !== "none") {
      const secretEnvironment: Record<string, string> = {};
      const secrets: { hosts: readonly string[]; name: string; placeholder: string }[] = [];
      for (const [index, credential] of options.credentials.entries()) {
        const value = typeof credential.value === "function" ? await credential.value() : credential.value;
        if (typeof value !== "string" || !value || value.includes("\0"))
          throw sandboxErrorDiagnostics.SANDBOX_R0160({ message: `[vitehub] Container Sandbox credential ${credential.name} must resolve to a non-empty string.` });
        const placeholder = `vitehub-${credential.name}-${randomBytes(16).toString("hex")}`;
        secretEnvironment[`VITEHUB_BROKER_SECRET_${index}`] = value;
        secrets.push({ hosts: credential.hosts, name: credential.name, placeholder });
        env[credential.name] = placeholder;
      }
      const brokerEnvironment: Record<string, string> = {
        VITEHUB_BROKER_ADDON: containerBrokerAddon,
        VITEHUB_BROKER_RULES: JSON.stringify({ allow: options.egress.allow, policy: options.egress.policy, secrets }),
        ...secretEnvironment,
      };
      // Secret values reach the broker through the CLI environment, never the command line.
      await required(docker([
        "run", "-d", "--name", broker, "--label", label, "--network", "bridge",
        "--user", "mitmproxy", "--security-opt", "no-new-privileges:true",
        ...Object.keys(brokerEnvironment).flatMap(key => ["-e", key]),
        "--entrypoint", "sh", options.brokerImage, "-c", containerBrokerEntrypoint,
      ], { env: brokerEnvironment, signal }), "start the Sandbox broker");
      created.containers.push(broker);
      await required(docker(["network", "connect", "--alias", brokerAlias, network, broker], { signal }), "connect the Sandbox broker");
      const ca = await waitForBroker(docker, broker, signal);
      const proxy = `http://${brokerAlias}:${brokerPort}`;
      Object.assign(env, {
        ALL_PROXY: proxy,
        CURL_CA_BUNDLE: brokerCaTarget,
        GIT_SSL_CAINFO: brokerCaTarget,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NODE_EXTRA_CA_CERTS: brokerCaTarget,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "localhost,127.0.0.1,::1",
        REQUESTS_CA_BUNDLE: brokerCaTarget,
        SSL_CERT_FILE: brokerCaTarget,
        all_proxy: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        no_proxy: "localhost,127.0.0.1,::1",
      });
      created.containers.unshift(name);
      await startSandboxContainer(options, docker, name, network, label, signal);
      await writeContainerFile(options.docker, name, brokerCaTarget, ca, signal, "0");
    } else {
      created.containers.unshift(name);
      await startSandboxContainer(options, docker, name, network, label, signal);
    }
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `[vitehub] Container Sandbox start failed: ${messageOf(error)} Cleanup failed: ${messageOf(cleanupError)}`);
    }
    throw error;
  }

  return createContainerSession({ cleanup, container: name, docker: options.docker, env, id });
}

async function startSandboxContainer(
  options: NormalizedContainerOptions,
  docker: (args: readonly string[], run?: Omit<DockerRunOptions, "docker">) => Promise<CommandResult>,
  name: string,
  network: string,
  label: string,
  signal: AbortSignal | undefined,
) {
  await required(docker([
    "run", "-d", "--name", name, "--label", label, "--network", network, "--init",
    "--security-opt", "no-new-privileges:true", "--cap-drop", "NET_RAW", "--pids-limit", String(options.pidsLimit),
    ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
    ...(options.memoryBytes === undefined ? [] : ["--memory", String(options.memoryBytes)]),
    ...(options.user === undefined ? [] : ["--user", options.user]),
    "--entrypoint", "sh", options.image, "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
  ], { signal }), "start the Sandbox container");
  // The Sandbox user owns its root, so it can replace Home and the workspace without root.
  const owner = options.user === undefined ? "\"$(id -u):$(id -g)\"" : shellQuote(options.user);
  const setup = await docker(["exec", ...(options.user === undefined ? [] : ["-u", "0"]), name, "sh", "-c",
    `mkdir -p ${sandboxRoot} ${pidDirectory} && chown ${owner} ${sandboxRoot} ${pidDirectory}`,
  ], { signal });
  if (setup.exitCode !== 0) {
    throw sandboxErrorDiagnostics.SANDBOX_R0161({ message: `[vitehub] Container Sandbox could not prepare ${sandboxRoot}. Run the image as root, or set user to a user that root can chown to: ${setup.stderr.trim()}` });
  }
}

async function waitForBroker(
  docker: (args: readonly string[], run?: Omit<DockerRunOptions, "docker">) => Promise<CommandResult>,
  broker: string,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 30_000;
  const probe = `test -s ${containerBrokerCaPath} && python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${brokerPort}), 1)' && cat ${containerBrokerCaPath}`;
  let last: CommandResult | undefined;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    last = await docker(["exec", broker, "sh", "-c", probe], { signal });
    if (last.exitCode === 0 && last.stdout.includes("BEGIN CERTIFICATE")) return last.stdout;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const logs = await docker(["logs", "--tail", "20", broker]);
  throw sandboxErrorDiagnostics.SANDBOX_R0161({ message: `[vitehub] Container Sandbox broker did not start within 30 seconds: ${(last?.stderr || "").trim()} ${logs.stdout.trim()} ${logs.stderr.trim()}`.trim() });
}

interface DockerRunOptions {
  docker: string;
  env?: Record<string, string>;
  input?: Uint8Array;
  signal?: AbortSignal;
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function required(result: Promise<CommandResult>, action: string) {
  const value = await result;
  if (value.exitCode !== 0)
    throw sandboxErrorDiagnostics.SANDBOX_R0161({ message: `[vitehub] Container Sandbox could not ${action}: ${value.stderr.trim() || value.stdout.trim()}` });
  return value;
}

function spawnDocker(options: DockerRunOptions, args: readonly string[], stdin: boolean) {
  return spawnChildProcess(options.docker, args, {
    env: { ...process.env, ...options.env },
    stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

async function dockerCommand(options: DockerRunOptions, args: readonly string[]): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const child = spawnDocker(options, args, options.input !== undefined);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (options.input !== undefined) {
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(options.input);
  }
  const abort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await waitForExit(child);
    options.signal?.throwIfAborted();
    return { exitCode, stderr: Buffer.concat(stderr).toString("utf8"), stdout: Buffer.concat(stdout).toString("utf8") };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function waitForExit(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + signalNumber(signal) : 1)));
  });
}

function signalNumber(signal: NodeJS.Signals) {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Partial<Record<NodeJS.Signals, number>>)[signal] ?? 0;
}

async function writeContainerFile(docker: string, container: string, path: string, content: string | Uint8Array, signal: AbortSignal | undefined, user?: string) {
  const result = await dockerCommand(
    { docker, input: typeof content === "string" ? new TextEncoder().encode(content) : content, signal },
    ["exec", "-i", ...(user === undefined ? [] : ["-u", user]), container, "sh", "-c", `cat > ${shellQuote(path)} && chmod 0644 ${shellQuote(path)}`],
  );
  if (result.exitCode !== 0)
    throw sandboxErrorDiagnostics.SANDBOX_R0163({ message: `[vitehub] Container Sandbox could not write ${path}: ${result.stderr.trim()}` });
}

function createContainerSession(state: {
  cleanup: () => Promise<void>;
  container: string;
  docker: string;
  env: Record<string, string>;
  id: string;
}): RuntimeSession {
  const children = new Set<ChildProcess>();
  let destroyPromise: Promise<void> | undefined;

  /** Starts `command` in the Sandbox. The wrapper records the process id so kill() reaches the Sandbox process, not only the Docker CLI. */
  const start = (options: Parameters<RuntimeSession["run"]>[0], stdin: boolean) => {
    const pidFile = `${pidDirectory}/${randomUUID()}`;
    const environment = { ...state.env, ...options.env };
    const inline: string[] = [];
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (cliEnvironment(key)) inline.push("-e", `${key}=${value}`);
      else {
        inherited[key] = value;
        inline.push("-e", key);
      }
    }
    // An explicit working directory must exist. Setup commands run before the workspace exists, so they fall back to /.
    const enter = options.workingDirectory === undefined
      ? `cd ${sandboxWorkspace} 2>/dev/null || cd /`
      : "cd -- \"$2\" || exit 127";
    const child = spawnDocker({ docker: state.docker, env: inherited }, [
      "exec", ...(stdin ? ["-i"] : []), "-w", "/", ...inline,
      state.container, "sh", "-c", `echo $$ > "$0"; ${enter}; exec sh -c "$1"`, pidFile, options.command,
      ...(options.workingDirectory === undefined ? [] : [options.workingDirectory]),
    ], stdin);
    children.add(child);
    let exited = false;
    const exit = waitForExit(child).finally(() => {
      exited = true;
      children.delete(child);
      void dockerCommand({ docker: state.docker }, ["exec", state.container, "rm", "-f", pidFile]).catch(() => undefined);
    });
    const kill = async (signal = "TERM") => {
      const name = signal.replace(/^SIG/, "").toUpperCase();
      if (!/^[A-Z0-9]+$/.test(name)) throw sandboxErrorDiagnostics.SANDBOX_R0164({ message: `[vitehub] Invalid signal: ${signal}` });
      const deadline = Date.now() + 10_000;
      while (!exited) {
        const result = await dockerCommand({ docker: state.docker }, ["exec", state.container, "sh", "-c",
          `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null) && [ -n "$pid" ] || exit 3; kill -s ${name} -- "-$pid" 2>/dev/null || kill -s ${name} "$pid"`]);
        if (exited) return;
        if (result.exitCode === 0) {
          if (name === "KILL") child.kill("SIGKILL");
          return;
        }
        // The Docker CLI can return a process handle before its shell registers the PID.
        if (result.exitCode !== 3 || Date.now() >= deadline)
          throw sandboxErrorDiagnostics.SANDBOX_R0164({ message: `[vitehub] Container Sandbox could not signal the process: ${result.stderr.trim() || "PID registration timed out."}` });
        await delay(50);
      }
    };
    return { child, exit, kill };
  };

  const run: RuntimeSession["run"] = async (options) => {
    options.abortSignal?.throwIfAborted();
    const { child, exit, kill } = start(options, false);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    let termination: Promise<void> | undefined;
    const abort = () => {
      termination = kill("KILL").catch((error) => {
        child.kill("SIGKILL");
        throw error;
      });
      void termination.catch(() => undefined);
    };
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const exitCode = await exit;
      await termination;
      options.abortSignal?.throwIfAborted();
      return { exitCode, stderr: Buffer.concat(stderr).toString("utf8"), stdout: Buffer.concat(stdout).toString("utf8") };
    } finally {
      options.abortSignal?.removeEventListener("abort", abort);
    }
  };

  const readFile = async (path: string, abortSignal?: AbortSignal) => {
    abortSignal?.throwIfAborted();
    const child = spawnDocker({ docker: state.docker }, ["exec", state.container, "sh", "-c",
      `if [ -f ${shellQuote(path)} ]; then exec cat -- ${shellQuote(path)}; elif [ -e ${shellQuote(path)} ]; then echo "not a file" >&2; exit 2; else exit 3; fi`], false);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    const abort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const exitCode = await waitForExit(child);
      abortSignal?.throwIfAborted();
      if (exitCode === 3) return null;
      if (exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0163({ message: `[vitehub] Container Sandbox could not read ${path}: ${Buffer.concat(stderr).toString("utf8").trim()}` });
      return new Uint8Array(Buffer.concat(stdout));
    } finally {
      abortSignal?.removeEventListener("abort", abort);
    }
  };

  const checked = async (options: { abortSignal?: AbortSignal; command: string }, action: string) => {
    const result = await run(options);
    if (result.exitCode !== 0)
      throw sandboxErrorDiagnostics.SANDBOX_R0163({ message: `[vitehub] Container Sandbox could not ${action}: ${(result.stderr || result.stdout).trim()}` });
  };

  const destroy = async () => {
    destroyPromise ??= (async () => {
      for (const child of children) child.kill("SIGKILL");
      await state.cleanup();
    })();
    try {
      await destroyPromise;
    } catch (error) {
      destroyPromise = undefined;
      throw error;
    }
  };

  return {
    defaultWorkingDirectory: sandboxWorkspace,
    id: state.id,
    destroy,
    async existsFile({ abortSignal, path: input }) {
      const path = sandboxPath(input);
      return (await run({ abortSignal, command: `test -e ${shellQuote(path)} || test -L ${shellQuote(path)}` })).exitCode === 0;
    },
    async listFiles({ abortSignal, path: input, recursive }) {
      const path = sandboxPath(input);
      return await listCommandFiles(run, { abortSignal, path, recursive }, result => sandboxErrorDiagnostics.SANDBOX_R0163({ message: `[vitehub] Container Sandbox could not list ${path}: ${result.stderr.trim()}` }));
    },
    async makeDirectory({ abortSignal, path: input, recursive }) {
      const path = sandboxPath(input);
      await checked({ abortSignal, command: `mkdir ${recursive ? "-p " : ""}-- ${shellQuote(path)}` }, `create ${path}`);
    },
    async moveFile({ abortSignal, destination, source }) {
      await checked({ abortSignal, command: `mv -- ${shellQuote(sandboxPath(source))} ${shellQuote(sandboxPath(destination))}` }, `move ${source}`);
    },
    async readBinaryFile({ abortSignal, path }) {
      return await readFile(sandboxPath(path), abortSignal);
    },
    async removeFile({ abortSignal, path: input, recursive }) {
      const path = sandboxPath(input);
      await checked({
        abortSignal,
        command: recursive
          ? `rm -rf -- ${shellQuote(path)}`
          : `if test -d ${shellQuote(path)} && ! test -L ${shellQuote(path)}; then rmdir -- ${shellQuote(path)}; else rm -f -- ${shellQuote(path)}; fi`,
      }, `remove ${path}`);
    },
    run,
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      const stdin = options.stdin === true;
      const { child, exit, kill } = start(options, stdin);
      let termination: Promise<void> | undefined;
      const abort = () => {
        termination = kill("KILL").catch((error) => {
          child.kill("SIGKILL");
          throw error;
        });
        void termination.catch(() => undefined);
      };
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      void exit.finally(() => options.abortSignal?.removeEventListener("abort", abort)).catch(() => undefined);
      const process: RuntimeProcess = {
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        ...(stdin ? { stdin: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array> } : {}),
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        async kill(signal?: string) {
          await kill(signal);
        },
        async wait() {
          const exitCode = await exit;
          await termination;
          if (termination) throw options.abortSignal!.reason;
          return { exitCode };
        },
      };
      return process;
    },
    stop: destroy,
    async writeBinaryFile({ abortSignal, content, path }) {
      await writeContainerFile(state.docker, state.container, sandboxPath(path), content, abortSignal);
    },
  };
}

/** Relative file paths are relative to the Sandbox workspace, like command working directories. */
function sandboxPath(path: string) {
  return posix.isAbsolute(path) ? path : posix.join(sandboxWorkspace, path);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

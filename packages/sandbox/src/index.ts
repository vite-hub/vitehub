import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { normalizeExecutionAuthority, type ExecutionAuthority } from "@vite-hub/runtime";
import type { CloudflareSandboxOptions, CloudflareDurableObjectNamespace, CloudflareSandboxStub } from "./cloudflare.ts";
import type { CrabboxOptions } from "./internal/crabbox.ts";
import type { TrustedHostOptions } from "./internal/trusted-host.ts";
import type {
  VercelSandboxNetworkPolicy,
  VercelSandboxOptions,
  VercelSandboxSource,
  VercelFileStat,
  VercelSandboxCommand,
  VercelSandboxCreateOptions,
  VercelSandboxInstance,
} from "./vercel.ts";
import { hasDeclaredSandboxRuntimeMember, isBuiltInSandboxRuntime } from "./internal/runtime.ts";
import { sandboxErrorDiagnostics } from "./error-diagnostics.ts"

export type {
  CloudflareSandboxOptions,
  CloudflareDurableObjectNamespace,
  CloudflareSandboxStub,
  CrabboxOptions,
  TrustedHostOptions,
  VercelSandboxNetworkPolicy,
  VercelSandboxOptions,
  VercelSandboxSource,
  VercelFileStat,
  VercelSandboxCommand,
  VercelSandboxCreateOptions,
  VercelSandboxInstance,
};

export type SandboxRequirement =
  | string
  | {
      args?: readonly string[];
      command: string;
      name?: string;
      timeout?: number;
    };

export type SandboxValue<T, Context> =
  | T
  | ((context: Context) => T | undefined | Promise<T | undefined>);

export type SandboxFile<Context> =
  | { contents: SandboxValue<string | Uint8Array, Context> }
  | { from: string };

export interface SandboxHome<Context> {
  files?: Readonly<Record<string, SandboxFile<Context>>>;
  state?: Readonly<
    Record<
      string,
      {
        key: string;
        seed?: Readonly<Record<string, SandboxFile<Context>>>;
      }
    >
  >;
}

export interface SandboxCheckout<Context> {
  ref: SandboxValue<string, Context>;
  remote: SandboxValue<string, Context>;
  sha: SandboxValue<string, Context>;
}

/**
 * Node.js and package manager for Sandbox commands. `"project"` reads both from
 * the project, the same as `{ node: "project", packageManager: "project" }`.
 */
export type SandboxToolchain = "project" | SandboxToolchainOptions;

export interface SandboxToolchainOptions {
  /** Node.js version, range, or alias used when the project pins none. */
  fallbackNode?: string;
  /** `"project"` (default) or a Node.js version, range, or alias such as `22`, `^22.11.0`, or `lts/*`. */
  node?: "project" | (string & {});
  /** `"project"` (default) reads package.json; `false` uses the npm bundled with Node.js; or `name@version`. */
  packageManager?: "project" | false | (string & {});
}

export interface SandboxToolchainPin {
  /** Project file or option that declared the version, such as `.node-version`. */
  readonly source: string;
  /** Declared version, range, or alias. */
  readonly version: string;
}

export interface SandboxToolchainPackageManagerPin extends SandboxToolchainPin {
  /** Expected `algorithm.hex` digest from a package.json packageManager value. */
  readonly integrity?: string;
  readonly name: "npm" | "pnpm" | "yarn";
}

export interface SandboxToolchainPins {
  readonly node: SandboxToolchainPin;
  readonly packageManager?: SandboxToolchainPackageManagerPin;
}

/** Normalized toolchain declaration passed to Sandbox runtimes. */
export interface SandboxToolchainInput {
  readonly fallbackNode?: string;
  readonly node: string;
  readonly packageManager: string | false;
  /** Pins read before the Sandbox opened. Runtimes read checkout pins after materialization. */
  readonly pins?: SandboxToolchainPins;
}

export interface SandboxToolchainPlan {
  readonly node?: SandboxToolchainPin;
  readonly packageManager?: SandboxToolchainPackageManagerPin;
  /** `checkout` pins are read from the Sandbox checkout each time it opens. */
  readonly source: "checkout" | "project";
}

/** Toolchain provisioned for an open Sandbox session. */
export interface SandboxResolvedToolchain {
  /** Directories prepended to PATH, in order. */
  readonly bin: readonly string[];
  readonly node: { readonly source: string; readonly version: string };
  readonly packageManager?: {
    readonly name: SandboxToolchainPackageManagerPin["name"];
    readonly source: string;
    readonly version: string;
  };
}

export interface SandboxDefinition<Context = unknown> {
  checkout?: SandboxCheckout<Context>;
  cwd?: SandboxValue<string, Context>;
  env?: Readonly<Record<string, SandboxValue<string, Context>>>;
  home?: SandboxHome<Context>;
  requires?: readonly SandboxRequirement[];
  runtime: SandboxRuntimeDefinition;
  /** Provision project-pinned Node.js and package manager before requirement checks. */
  toolchain?: SandboxToolchain;
}

export type BuiltInSandboxRuntimeName = "crabbox" | "trusted-host" | "vercel";

export type BuiltInSandboxRuntime =
  | BuiltInSandboxRuntimeName
  | ({ kind: "crabbox" } & CrabboxOptions)
  | ({ kind: "trusted-host" } & TrustedHostOptions)
  | ({ kind: "cloudflare" } & CloudflareSandboxOptions)
  | ({ kind: "vercel" } & VercelSandboxOptions);

export type SandboxRuntimeDefinition = BuiltInSandboxRuntime | SandboxRuntime;

export interface SandboxRuntime {
  readonly name: string;
  /** Set when sessions reach loopback services of the ViteHub process, for example through SSH tunnels. */
  readonly network?: "direct";
  open(input: SandboxRuntimeInput, options: SandboxRuntimeOpenOptions): Promise<SandboxSession>;
  prepare(input: SandboxRuntimeInput): Promise<SandboxRuntimePlan>;
}

export interface SandboxOpenOptions {
  id?: string;
  initialize?: (
    session: SandboxSession,
    context: { signal?: AbortSignal },
  ) => Promise<void>;
  signal?: AbortSignal;
}

export interface SandboxRuntimeOpenOptions extends SandboxOpenOptions {
  readonly executionAuthority: ExecutionAuthority;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeout?: number;
}

export interface SandboxExecResult {
  readonly code: number;
  readonly ok: boolean;
  readonly stderr: string;
  readonly stdout: string;
}

export interface SandboxProcessExit {
  readonly code: number;
}

export interface SandboxProcess {
  readonly pid?: number;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Process input. Present only when the runtime forwards stdin to the command. */
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<SandboxProcessExit>;
}

export interface SandboxFileEntry {
  readonly path: string;
  readonly size?: number;
  readonly type: "directory" | "file" | "symlink";
}

export interface SandboxFileOptions {
  signal?: AbortSignal;
}

export interface SandboxListFilesOptions extends SandboxFileOptions {
  exclude?: readonly string[];
  recursive?: boolean;
}

export interface SandboxRemoveFileOptions extends SandboxFileOptions {
  recursive?: boolean;
}

export interface SandboxFiles {
  exists(path: string, options?: SandboxFileOptions): Promise<boolean>;
  list(path: string, options?: SandboxListFilesOptions): Promise<readonly SandboxFileEntry[]>;
  mkdir(path: string, options?: SandboxFileOptions & { recursive?: boolean }): Promise<void>;
  move?(source: string, destination: string, options?: SandboxFileOptions): Promise<void>;
  read(path: string, options?: SandboxFileOptions): Promise<Uint8Array | null>;
  remove(path: string, options?: SandboxRemoveFileOptions): Promise<void>;
  write(path: string, contents: Uint8Array, options?: SandboxFileOptions): Promise<void>;
}

export interface SandboxPorts {
  readonly values: readonly number[];
  expose(port: number, options?: { protocol?: "http" | "https" | "ws" }): Promise<URL>;
}

export interface SandboxSession {
  readonly cwd: string;
  readonly executionAuthority: ExecutionAuthority;
  readonly files: SandboxFiles;
  readonly id: string;
  readonly inspectionConcurrency?: number;
  readonly ports?: SandboxPorts;
  /** Provisioned toolchain, when the Sandbox declares one. */
  readonly toolchain?: SandboxResolvedToolchain;
  readonly spawn?: (
    command: string,
    args?: readonly string[],
    options?: SandboxExecOptions,
  ) => Promise<SandboxProcess>;
  close(): Promise<void>;
  exec(
    command: string,
    args?: readonly string[],
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  /** Replace the session workspace with a host checkout's working tree, when the runtime has a faster transfer. */
  importWorkspace?(checkout: string, signal?: AbortSignal): Promise<void>;
  /** Install the workspace's dependencies inside the session instead of receiving the host's installed outputs. */
  refreshDependencies?(checkout: string, signal?: AbortSignal): Promise<void>;
}

export interface ResolvedSandboxFile {
  readonly resolve: () => Promise<Uint8Array>;
}

export interface ResolvedSandboxState {
  readonly key: string;
  readonly path: string;
  readonly projections: readonly string[];
  readonly seed: Readonly<Record<string, ResolvedSandboxFile>>;
}

export interface ResolvedSandboxPlan {
  readonly env: Readonly<Record<string, () => Promise<string>>>;
  readonly files: Readonly<Record<string, ResolvedSandboxFile>>;
  readonly state: readonly ResolvedSandboxState[];
}

export interface ResolvedSandboxRequirementInput {
  readonly args: readonly string[];
  readonly command: string;
  readonly name: string;
  readonly timeout?: number;
}

export interface SandboxRuntimeInput {
  checkout?: ResolvedSandboxCheckout;
  cwd?: string;
  identity: string;
  plan: ResolvedSandboxPlan;
  requirements: readonly ResolvedSandboxRequirementInput[];
  toolchain?: SandboxToolchainInput;
}

export interface ResolvedSandboxCheckout {
  readonly ref: string;
  readonly remote: string;
  readonly sha: string;
}

export interface SandboxEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SandboxResolvedRequirement {
  readonly command: string;
  readonly name: string;
  readonly timeout?: number;
}

export interface SandboxPlan {
  /** Configured trusted-host command limits. Absent on runtimes without this contract. */
  readonly resources?: TrustedHostOptions["resources"];
  readonly cache: {
    readonly state: "disposable";
  };
  readonly environment: SandboxEnvironment;
  readonly executionAuthority: ExecutionAuthority;
  readonly home: {
    readonly state: readonly {
      readonly identity: string;
      readonly path: string;
    }[];
  };
  readonly identity: string;
  readonly requirements: readonly SandboxResolvedRequirement[];
  readonly runtime: string;
  readonly toolchain?: SandboxToolchainPlan;
  readonly workspace: {
    readonly path?: string;
    readonly state: "authoritative" | "disposable";
    readonly workDir?: "." | "workspace";
  };
}

export type SandboxRuntimePlan = Omit<SandboxPlan, "home"> & {
  readonly home?: SandboxPlan["home"];
};

export interface Sandbox {
  readonly plan: SandboxPlan;
  open(options?: SandboxOpenOptions): Promise<SandboxSession>;
}

export interface ResolveSandboxOptions {
  requires?: readonly SandboxRequirement[];
}

const reservedRuntimeNames = new Set([
  "cloudflare",
  "crabbox",
  "trusted-host",
  "vercel",
]);

async function resolveSandboxRuntime(value: unknown): Promise<SandboxRuntime> {
  if (isSandboxRuntime(value)) {
    if (reservedRuntimeNames.has(value.name) && !isBuiltInSandboxRuntime(value)) {
      throw sandboxErrorDiagnostics.SANDBOX_R0030({ message: `[vitehub] Custom Sandbox runtimes cannot use the reserved name "${value.name}". Select the built-in runtime by value instead.` });
    }
    return value;
  }
  if (typeof value === "string") {
    if (value === "crabbox") {
      const { createCrabboxRuntime } = await import("./internal/crabbox.ts");
      return createCrabboxRuntime();
    }
    if (value === "trusted-host") {
      const { createTrustedHostRuntime } = await import("./internal/trusted-host.ts");
      return createTrustedHostRuntime();
    }
    if (value === "vercel") {
      const { createVercelRuntime } = await import("./vercel.ts");
      return createVercelRuntime();
    }
    throw sandboxErrorDiagnostics.SANDBOX_R0031({ message: `[vitehub] Unknown Sandbox runtime "${value}". Expected "crabbox", "trusted-host", "vercel", a tagged built-in configuration, or a custom runtime.` });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sandboxErrorDiagnostics.SANDBOX_R0032({ message: "[vitehub] Sandbox requires an explicit built-in runtime value or custom runtime object." });
  }

  const { kind, ...options } = value as Record<string, unknown>;
  if (kind === "crabbox") {
    const { createCrabboxRuntime } = await import("./internal/crabbox.ts");
    return createCrabboxRuntime(options as CrabboxOptions);
  }
  if (kind === "trusted-host") {
    const { createTrustedHostRuntime } = await import("./internal/trusted-host.ts");
    return createTrustedHostRuntime(options as TrustedHostOptions);
  }
  if (kind === "cloudflare") {
    const { createCloudflareRuntime } = await import("./cloudflare.ts");
    return createCloudflareRuntime(options as unknown as CloudflareSandboxOptions);
  }
  if (kind === "vercel") {
    const { createVercelRuntime } = await import("./vercel.ts");
    return createVercelRuntime(options as VercelSandboxOptions);
  }
  throw sandboxErrorDiagnostics.SANDBOX_R0033({ message: `[vitehub] Unknown Sandbox runtime kind "${String(kind)}". Expected "crabbox", "trusted-host", "cloudflare", or "vercel".` });
}

function isSandboxRuntime(value: unknown): value is SandboxRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Partial<SandboxRuntime>;
  return hasDeclaredSandboxRuntimeMember(runtime, "name")
    && hasDeclaredSandboxRuntimeMember(runtime, "open")
    && hasDeclaredSandboxRuntimeMember(runtime, "prepare")
    && typeof runtime.name === "string"
    && typeof runtime.open === "function"
    && typeof runtime.prepare === "function";
}

const reservedEnvironment = new Set([
  "CODEX_HOME",
  "HOME",
  "INIT_CWD",
  "OLDPWD",
  "PWD",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

export async function resolveSandbox<Context>(
  definition: SandboxDefinition<Context>,
  context: Context,
  options: ResolveSandboxOptions = {},
): Promise<Sandbox> {
  if (!definition || typeof definition !== "object")
    throw sandboxErrorDiagnostics.SANDBOX_R0034({ message: "[vitehub] Sandbox requires a definition." });
  const runtime = await resolveSandboxRuntime(definition.runtime);
  if (definition.cwd !== undefined && definition.checkout !== undefined) {
    throw sandboxErrorDiagnostics.SANDBOX_R0035({ message: "[vitehub] Sandbox checkout cannot be combined with cwd." });
  }
  const cwdValue = await resolveValue(definition.cwd, context);
  const cwd = cwdValue === undefined ? undefined : resolve(resolveString(cwdValue, "cwd"));
  const checkout = definition.checkout
    ? {
        ref: resolveString(await resolveValue(definition.checkout.ref, context), "checkout ref"),
        remote: resolveString(
          await resolveValue(definition.checkout.remote, context),
          "checkout remote",
        ),
        sha: resolveSha(await resolveValue(definition.checkout.sha, context)),
      }
    : undefined;
  const plan = resolvePlan(definition, context, cwd || process.cwd());
  const toolchain = await resolveToolchain(definition.toolchain, checkout ? undefined : cwd || process.cwd());
  const requirements = normalizeRequirements([
    ...(checkout ? ["git"] : []),
    ...(toolchain ? ["node", ...(toolchain.pins?.packageManager ? [toolchain.pins.packageManager.name] : [])] : []),
    ...(definition.requires || []),
    ...(options.requires || []),
  ]);
  const input: SandboxRuntimeInput = {
    ...(checkout ? { checkout } : {}),
    ...(cwd ? { cwd } : {}),
    identity: planIdentity(plan, requirements, checkout, toolchain),
    plan,
    requirements,
    ...(toolchain ? { toolchain } : {}),
  };
  const prepared = await runtime.prepare(input);
  let executionAuthority: ExecutionAuthority;
  try {
    executionAuthority = normalizeExecutionAuthority(prepared.executionAuthority);
  } catch {
    throw sandboxErrorDiagnostics.SANDBOX_R0036({ message: `[vitehub] Sandbox runtime ${runtime.name} must declare executionAuthority.` });
  }
  const homeState = plan.state.map((state) => {
    const preparedState = prepared.home?.state.find(target => target.path === state.path);
    if (typeof preparedState?.identity !== "string" || !preparedState.identity) {
      throw sandboxErrorDiagnostics.SANDBOX_R0037({ message: `[vitehub] Sandbox runtime ${runtime.name} must declare an opaque Home state identity for ${state.path}.` });
    }
    return Object.freeze({ identity: preparedState.identity, path: state.path });
  });
  const sandboxPlan = Object.freeze({
    ...prepared,
    executionAuthority,
    home: Object.freeze({
      state: Object.freeze(homeState),
    }),
    ...(toolchain
      ? {
          toolchain: Object.freeze({
            ...(toolchain.pins?.node ? { node: toolchain.pins.node } : {}),
            ...(toolchain.pins?.packageManager ? { packageManager: toolchain.pins.packageManager } : {}),
            source: toolchain.pins ? "project" as const : "checkout" as const,
          }),
        }
      : {}),
  });
  return Object.freeze({
    async open(options?: SandboxOpenOptions) {
      options?.signal?.throwIfAborted();
      const session = await runtime.open(input, {
        ...options,
        executionAuthority: sandboxPlan.executionAuthority,
      });
      if (toolchain && !session.toolchain) {
        await session.close().catch(() => undefined);
        throw sandboxErrorDiagnostics.SANDBOX_R0156({ message: `[vitehub] Sandbox runtime ${runtime.name} does not provision toolchains. Use a built-in runtime or remove sandbox.toolchain.` });
      }
      return session;
    },
    plan: sandboxPlan,
  });
}

/** Read toolchain pins now unless they come from a checkout that exists only after open. */
async function resolveToolchain(
  declaration: SandboxToolchain | undefined,
  projectRoot: string | undefined,
): Promise<SandboxToolchainInput | undefined> {
  if (declaration === undefined) return;
  // Sandboxes without a toolchain do not load the provisioner or its Node.js dependencies.
  const [{ normalizeToolchain, readToolchainPins, toolchainReadsProject }, { readHostProjectFiles }] = await Promise.all([
    import("./internal/toolchain.ts"),
    import("./internal/host-toolchain.ts"),
  ]);
  const toolchain = normalizeToolchain(declaration, "sandbox.toolchain");
  if (!toolchain) return;
  if (!projectRoot && toolchainReadsProject(toolchain)) return toolchain;
  const files = toolchainReadsProject(toolchain) ? await readHostProjectFiles(projectRoot!) : {};
  return Object.freeze({ ...toolchain, pins: readToolchainPins(toolchain, files) });
}

function planIdentity(
  plan: ResolvedSandboxPlan,
  requirements: readonly ResolvedSandboxRequirementInput[],
  checkout: ResolvedSandboxCheckout | undefined,
  toolchain: SandboxToolchainInput | undefined,
) {
  const value = JSON.stringify({
    checkout,
    toolchain,
    env: Object.keys(plan.env).toSorted(),
    files: Object.keys(plan.files).toSorted(),
    requirements,
    state: plan.state
      .map(({ key, path, seed }) => ({ key, path, seed: Object.keys(seed).toSorted() }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  const fingerprint = createHash("sha256").update(value).digest("hex");
  const hasResolvedInputs =
    Object.keys(plan.env).length > 0 ||
    Object.keys(plan.files).length > 0 ||
    plan.state.some(({ seed }) => Object.keys(seed).length > 0);
  return hasResolvedInputs ? `${fingerprint}-${randomUUID()}` : fingerprint;
}

function resolvePlan<Context>(
  definition: SandboxDefinition<Context>,
  context: Context,
  sourceRoot: string,
): ResolvedSandboxPlan {
  if (
    definition.home !== undefined &&
    (!definition.home || typeof definition.home !== "object" || Array.isArray(definition.home))
  ) {
    throw sandboxErrorDiagnostics.SANDBOX_R0038({ message: "[vitehub] Sandbox home must be a declarative object." });
  }
  const env = Object.fromEntries(
    Object.entries(optionalRecord(definition.env, "env")).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw sandboxErrorDiagnostics.SANDBOX_R0039({ message: `[vitehub] Invalid Sandbox environment variable: ${name}` });
      if (reservedEnvironment.has(name))
        throw sandboxErrorDiagnostics.SANDBOX_R0040({ message: `[vitehub] ${name} is managed by the Sandbox runtime.` });
      return [
        name,
        async () => {
          const resolved = await resolveValue(value, context);
          if (resolved === undefined)
            throw sandboxErrorDiagnostics.SANDBOX_R0041({ message: `[vitehub] Sandbox environment value ${name} is required.` });
          return resolveString(resolved, `environment value ${name}`);
        },
      ];
    }),
  );
  const files = normalizeFiles(definition.home?.files, context, "home.files", sourceRoot);
  const state = Object.entries(optionalRecord(definition.home?.state, "home.state")).map(
    ([path, value]) => {
      const target = relativePath(path, "home.state target");
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.key !== "string" ||
        !value.key.trim()
      ) {
        throw sandboxErrorDiagnostics.SANDBOX_R0042({ message: `[vitehub] Sandbox state ${path} requires a non-empty key.` });
      }
      return {
        key: value.key.trim(),
        path: target,
        projections: [] as string[],
        seed: normalizeFiles(value.seed, context, `home.state ${path} seed`, sourceRoot),
      };
    },
  );
  const stateKeys = new Set<string>();
  for (const value of state) {
    if (stateKeys.has(value.key))
      throw sandboxErrorDiagnostics.SANDBOX_R0043({ message: `[vitehub] Sandbox state keys must be unique: ${value.key}` });
    stateKeys.add(value.key);
  }
  validateTargets(
    Object.keys(files),
    state.map((value) => value.path),
  );
  for (const value of state) {
    const projectedFiles = Object.keys(files)
      .filter((file) => isDescendant(file, value.path))
      .map((file) => file.slice(value.path.length + 1));
    value.projections.push(...projectedFiles.toSorted());
    validateFileTargets(
      [...Object.keys(value.seed), ...projectedFiles],
      `home.state ${value.path} projected`,
    );
  }
  return {
    env: Object.freeze(env),
    files: Object.freeze(files),
    state: Object.freeze(state),
  };
}

function normalizeFiles<Context>(
  input: Readonly<Record<string, SandboxFile<Context>>> | undefined,
  context: Context,
  label: string,
  sourceRoot: string,
): Record<string, ResolvedSandboxFile> {
  const files = Object.fromEntries(
    Object.entries(optionalRecord(input, label)).map(([path, value]) => {
      const target = relativePath(path, `${label} target`);
      if (!value || typeof value !== "object")
        throw sandboxErrorDiagnostics.SANDBOX_R0044({ message: `[vitehub] Sandbox file ${path} requires from or contents.` });
      const hasFrom = "from" in value;
      const hasContents = "contents" in value;
      const ownsFrom = Object.hasOwn(value, "from");
      const ownsContents = Object.hasOwn(value, "contents");
      if ((hasFrom !== ownsFrom) || (hasContents !== ownsContents))
        throw sandboxErrorDiagnostics.SANDBOX_R0046({ message: `[vitehub] Sandbox file ${path} requires exactly one of from or contents.` });
      if (hasFrom && ownsFrom) {
        if (Object.keys(value).length !== 1 || typeof value.from !== "string")
          throw sandboxErrorDiagnostics.SANDBOX_R0045({ message: `[vitehub] Sandbox file ${path} requires exactly one of from or contents.` });
        const source = relativePath(value.from, `${label} source`);
        return [target, { resolve: async () => await readProjectFile(source) }];
      }
      if (!(hasContents && ownsContents) || Object.keys(value).length !== 1)
        throw sandboxErrorDiagnostics.SANDBOX_R0046({ message: `[vitehub] Sandbox file ${path} requires exactly one of from or contents.` });
      return [
        target,
        {
          resolve: async () => {
            const resolved = await resolveValue(value.contents, context);
            if (resolved === undefined) throw sandboxErrorDiagnostics.SANDBOX_R0047({ message: `[vitehub] Sandbox file ${path} is required.` });
            if (typeof resolved === "string") return new TextEncoder().encode(resolved);
            if (isUint8ArrayValue(resolved)) return resolved;
            throw sandboxErrorDiagnostics.SANDBOX_R0048({ message: `[vitehub] Sandbox file ${path} must resolve to text or bytes.` });
          },
        },
      ];
    }),
  );
  validateFileTargets(Object.keys(files), label);
  return files;

  async function readProjectFile(path: string) {
    const root = await realpath(sourceRoot).catch(() => resolve(sourceRoot));
    const source = await realpath(resolve(root, path)).catch(() => undefined);
    const sourcePath = source ? relative(root, source) : undefined;
    if (!source || !sourcePath || sourcePath.startsWith("..") || isAbsolute(sourcePath)) {
      throw sandboxErrorDiagnostics.SANDBOX_R0049({ message: `[vitehub] Sandbox project file is unavailable: ${path}` });
    }
    return new Uint8Array(await readFile(source));
  }
}

function isUint8ArrayValue(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value)) return false;
  try {
    const elementType = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      Symbol.toStringTag,
    )?.get;
    return !!elementType && Reflect.apply(elementType, value, []) === "Uint8Array";
  } catch {
    return false;
  }
}

function validateFileTargets(files: readonly string[], label: string) {
  for (let index = 0; index < files.length; index++) {
    for (let other = index + 1; other < files.length; other++) {
      if (
        files[index] === files[other] ||
        isDescendant(files[index], files[other]) ||
        isDescendant(files[other], files[index])
      ) {
        throw sandboxErrorDiagnostics.SANDBOX_R0050({ message: `[vitehub] Sandbox ${label} targets conflict: ${files[index]} and ${files[other]}` });
      }
    }
  }
}

function validateTargets(files: readonly string[], state: readonly string[]) {
  for (let index = 0; index < state.length; index++) {
    for (let other = index + 1; other < state.length; other++) {
      if (isDescendant(state[index], state[other]) || isDescendant(state[other], state[index])) {
        throw sandboxErrorDiagnostics.SANDBOX_R0051({ message: `[vitehub] Sandbox state targets overlap: ${state[index]} and ${state[other]}` });
      }
    }
  }
  for (const file of files) {
    for (const directory of state) {
      if (file === directory || isDescendant(directory, file)) {
        throw sandboxErrorDiagnostics.SANDBOX_R0052({ message: `[vitehub] Sandbox file and state targets conflict: ${file} and ${directory}` });
      }
    }
  }
}

function isDescendant(path: string, parent: string) {
  return path.startsWith(`${parent}/`);
}

function optionalRecord<T>(
  value: Readonly<Record<string, T>> | undefined,
  label: string,
): Readonly<Record<string, T>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw sandboxErrorDiagnostics.SANDBOX_R0053({ message: `[vitehub] Sandbox ${label} must be an object.` });
  return value;
}

function relativePath(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw sandboxErrorDiagnostics.SANDBOX_R0054({ message: `[vitehub] Sandbox ${label} must be a non-empty relative POSIX path.` });
  }
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw sandboxErrorDiagnostics.SANDBOX_R0055({ message: `[vitehub] Sandbox ${label} must be a non-empty relative POSIX path.` });
  }
  return normalized;
}

function normalizeRequirements(
  input: readonly SandboxRequirement[],
): readonly ResolvedSandboxRequirementInput[] {
  const requirements = input.map((value): ResolvedSandboxRequirementInput => {
    if (typeof value === "string") {
      if (!value.trim())
        throw sandboxErrorDiagnostics.SANDBOX_R0056({ message: "[vitehub] Sandbox requirements must be non-empty commands." });
      const command = value.trim();
      if (command.includes("\0"))
        throw sandboxErrorDiagnostics.SANDBOX_R0057({ message: "[vitehub] Sandbox requirement commands and arguments cannot contain NUL." });
      return { args: [], command, name: command };
    }
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.command !== "string" ||
      !value.command.trim()
    ) {
      throw sandboxErrorDiagnostics.SANDBOX_R0058({ message: "[vitehub] Sandbox requirements must be commands or direct command checks." });
    }
    const rawArgs = value.args;
    if (rawArgs !== undefined && !Array.isArray(rawArgs))
      throw sandboxErrorDiagnostics.SANDBOX_R0059({ message: "[vitehub] Sandbox requirement arguments must be an array of strings." });
    const args = rawArgs === undefined ? [] : [...rawArgs];
    if (args.some((argument) => typeof argument !== "string"))
      throw sandboxErrorDiagnostics.SANDBOX_R0059({ message: "[vitehub] Sandbox requirement arguments must be strings." });
    const command = value.command.trim();
    if (command.includes("\0") || args.some((argument) => argument.includes("\0")))
      throw sandboxErrorDiagnostics.SANDBOX_R0060({ message: "[vitehub] Sandbox requirement commands and arguments cannot contain NUL." });
    const name = value.name?.trim() || [command, ...args].join(" ");
    const timeout = value.timeout;
    if (
      timeout !== undefined
      && (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2 ** 31 - 1)
    ) {
      throw sandboxErrorDiagnostics.SANDBOX_R0061({ message: "[vitehub] Sandbox requirement timeout must be a positive integer no greater than 2147483647ms." });
    }
    return { args, command, name, ...(timeout === undefined ? {} : { timeout }) };
  });
  return [...new Map(requirements.map((value) => [JSON.stringify(value), value])).values()];
}

function resolveString(value: unknown, label: string) {
  if (typeof value !== "string" || !value)
    throw sandboxErrorDiagnostics.SANDBOX_R0062({ message: `[vitehub] Sandbox ${label} must resolve to a non-empty string.` });
  if (value.includes("\0")) throw sandboxErrorDiagnostics.SANDBOX_R0063({ message: `[vitehub] Sandbox ${label} cannot contain NUL.` });
  return value;
}

function resolveSha(value: unknown) {
  const sha = resolveString(value, "checkout sha").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw sandboxErrorDiagnostics.SANDBOX_R0064({ message: "[vitehub] Sandbox checkout sha must be a full Git object id." });
  }
  return sha;
}

async function resolveValue<T, Context>(
  value: SandboxValue<T, Context> | undefined,
  context: Context,
): Promise<T | undefined> {
  return typeof value === "function"
    ? await (value as (context: Context) => T | undefined | Promise<T | undefined>)(context)
    : value;
}

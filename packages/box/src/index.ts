import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { normalizeExecutionAuthority, type ExecutionAuthority } from "@vite-hub/runtime";
import type { AsciiBoxOptions } from "./ascii.ts";
import type { CloudflareBoxOptions, CloudflareDurableObjectNamespace, CloudflareSandboxStub } from "./cloudflare.ts";
import type {
  CloudflareComputerBoxOptions,
  CloudflareComputerDurableObjectNamespace,
  CloudflareComputerExecHandle,
  CloudflareComputerFileStat,
  CloudflareComputerFilesystem,
  CloudflareComputerWorkspace,
} from "./cloudflare-computer.ts";
import type { CrabboxOptions } from "./internal/crabbox.ts";
import type { TrustedHostOptions } from "./internal/trusted-host.ts";
import type {
  VercelBoxNetworkPolicy,
  VercelBoxOptions,
  VercelBoxSource,
  VercelFileStat,
  VercelSandboxCommand,
  VercelSandboxCreateOptions,
  VercelSandboxInstance,
} from "./vercel.ts";
import { isBuiltInBoxRuntime } from "./internal/runtime.ts";

export type {
  AsciiBoxOptions,
  CloudflareBoxOptions,
  CloudflareComputerBoxOptions,
  CloudflareComputerDurableObjectNamespace,
  CloudflareComputerExecHandle,
  CloudflareComputerFileStat,
  CloudflareComputerFilesystem,
  CloudflareComputerWorkspace,
  CloudflareDurableObjectNamespace,
  CloudflareSandboxStub,
  CrabboxOptions,
  TrustedHostOptions,
  VercelBoxNetworkPolicy,
  VercelBoxOptions,
  VercelBoxSource,
  VercelFileStat,
  VercelSandboxCommand,
  VercelSandboxCreateOptions,
  VercelSandboxInstance,
};

export type BoxRequirement =
  | string
  | {
      args?: readonly string[];
      command: string;
      name?: string;
      timeout?: number;
    };

export type BoxValue<T, Context> =
  | T
  | ((context: Context) => T | undefined | Promise<T | undefined>);

export type BoxFile<Context> =
  | { contents: BoxValue<string | Uint8Array, Context> }
  | { from: string };

export interface BoxHome<Context> {
  files?: Readonly<Record<string, BoxFile<Context>>>;
  state?: Readonly<
    Record<
      string,
      {
        key: string;
        seed?: Readonly<Record<string, BoxFile<Context>>>;
      }
    >
  >;
}

export interface BoxCheckout<Context> {
  ref: BoxValue<string, Context>;
  remote: BoxValue<string, Context>;
  sha: BoxValue<string, Context>;
}

export interface BoxDefinition<Context = unknown> {
  checkout?: BoxCheckout<Context>;
  cwd?: BoxValue<string, Context>;
  env?: Readonly<Record<string, BoxValue<string, Context>>>;
  home?: BoxHome<Context>;
  requires?: readonly BoxRequirement[];
  runtime: BoxRuntimeDefinition;
}

export type BuiltInBoxRuntimeName = "ascii" | "crabbox" | "trusted-host" | "vercel";

export type BuiltInBoxRuntime =
  | BuiltInBoxRuntimeName
  | ({ kind: "ascii" } & AsciiBoxOptions)
  | ({ kind: "crabbox" } & CrabboxOptions)
  | ({ kind: "trusted-host" } & TrustedHostOptions)
  | ({ kind: "cloudflare" } & CloudflareBoxOptions)
  | ({ kind: "cloudflare-computer" } & CloudflareComputerBoxOptions)
  | ({ kind: "vercel" } & VercelBoxOptions);

export type BoxRuntimeDefinition = BuiltInBoxRuntime | BoxRuntime;

export interface BoxRuntime {
  readonly name: string;
  open(input: BoxRuntimeInput, options: BoxRuntimeOpenOptions): Promise<BoxSession>;
  prepare(input: BoxRuntimeInput): Promise<BoxPlan>;
}

export interface BoxOpenOptions {
  id?: string;
  initialize?: (
    session: BoxSession,
    context: { signal?: AbortSignal },
  ) => Promise<void>;
  signal?: AbortSignal;
}

export interface BoxRuntimeOpenOptions extends BoxOpenOptions {
  readonly executionAuthority: ExecutionAuthority;
}

export interface BoxExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeout?: number;
}

export interface BoxExecResult {
  readonly code: number;
  readonly ok: boolean;
  readonly stderr: string;
  readonly stdout: string;
}

export interface BoxProcessExit {
  readonly code: number;
}

export interface BoxProcess {
  readonly pid?: number;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<BoxProcessExit>;
}

export interface BoxFileEntry {
  readonly path: string;
  readonly size?: number;
  readonly type: "directory" | "file" | "symlink";
}

export interface BoxFileOptions {
  signal?: AbortSignal;
}

export interface BoxListFilesOptions extends BoxFileOptions {
  recursive?: boolean;
}

export interface BoxRemoveFileOptions extends BoxFileOptions {
  recursive?: boolean;
}

export interface BoxFiles {
  exists(path: string, options?: BoxFileOptions): Promise<boolean>;
  list(path: string, options?: BoxListFilesOptions): Promise<readonly BoxFileEntry[]>;
  mkdir(path: string, options?: BoxFileOptions & { recursive?: boolean }): Promise<void>;
  move?(source: string, destination: string, options?: BoxFileOptions): Promise<void>;
  read(path: string, options?: BoxFileOptions): Promise<Uint8Array | null>;
  remove(path: string, options?: BoxRemoveFileOptions): Promise<void>;
  write(path: string, contents: Uint8Array, options?: BoxFileOptions): Promise<void>;
}

export interface BoxPorts {
  readonly values: readonly number[];
  expose(port: number, options?: { protocol?: "http" | "https" | "ws" }): Promise<URL>;
}

export interface BoxSession {
  readonly cwd: string;
  readonly executionAuthority: ExecutionAuthority;
  readonly files: BoxFiles;
  readonly id: string;
  readonly ports?: BoxPorts;
  readonly spawn?: (
    command: string,
    args?: readonly string[],
    options?: BoxExecOptions,
  ) => Promise<BoxProcess>;
  close(): Promise<void>;
  exec(
    command: string,
    args?: readonly string[],
    options?: BoxExecOptions,
  ): Promise<BoxExecResult>;
}

export interface ResolvedBoxFile {
  readonly resolve: () => Promise<Uint8Array>;
}

export interface ResolvedBoxState {
  readonly key: string;
  readonly path: string;
  readonly projections: readonly string[];
  readonly seed: Readonly<Record<string, ResolvedBoxFile>>;
}

export interface ResolvedBoxPlan {
  readonly env: Readonly<Record<string, () => Promise<string>>>;
  readonly files: Readonly<Record<string, ResolvedBoxFile>>;
  readonly state: readonly ResolvedBoxState[];
}

export interface ResolvedBoxRequirementInput {
  readonly args: readonly string[];
  readonly command: string;
  readonly name: string;
  readonly timeout?: number;
}

export interface BoxRuntimeInput {
  checkout?: ResolvedBoxCheckout;
  cwd?: string;
  identity: string;
  plan: ResolvedBoxPlan;
  requirements: readonly ResolvedBoxRequirementInput[];
}

export interface ResolvedBoxCheckout {
  readonly ref: string;
  readonly remote: string;
  readonly sha: string;
}

export interface BoxEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BoxResolvedRequirement {
  readonly command: string;
  readonly name: string;
  readonly timeout?: number;
}

export interface BoxPlan {
  readonly cache: {
    readonly state: "disposable";
  };
  readonly environment: BoxEnvironment;
  readonly executionAuthority: ExecutionAuthority;
  readonly home?: {
    readonly state: readonly {
      readonly identity: string;
      readonly path: string;
    }[];
  };
  readonly identity: string;
  readonly requirements: readonly BoxResolvedRequirement[];
  readonly runtime: string;
  readonly workspace: {
    readonly path?: string;
    readonly state: "authoritative" | "disposable";
    readonly workDir?: "." | "workspace";
  };
}

export interface Box {
  readonly plan: BoxPlan;
  open(options?: BoxOpenOptions): Promise<BoxSession>;
}

export interface ResolveBoxOptions {
  requires?: readonly BoxRequirement[];
}

const reservedRuntimeNames = new Set([
  "ascii",
  "cloudflare",
  "cloudflare-computer",
  "crabbox",
  "trusted-host",
  "vercel",
]);

async function resolveBoxRuntime(value: unknown): Promise<BoxRuntime> {
  if (isBoxRuntime(value)) {
    if (reservedRuntimeNames.has(value.name) && !isBuiltInBoxRuntime(value)) {
      throw new Error(`[vitehub] Custom Box runtimes cannot use the reserved name "${value.name}". Select the built-in runtime by value instead.`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value === "ascii") {
      const { createAsciiRuntime } = await import("./ascii.ts");
      return createAsciiRuntime();
    }
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
    throw new Error(`[vitehub] Unknown Box runtime "${value}". Expected "ascii", "crabbox", "trusted-host", "vercel", a tagged built-in configuration, or a custom runtime.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("[vitehub] Box requires an explicit built-in runtime value or custom runtime object.");
  }

  const { kind, ...options } = value as Record<string, unknown>;
  if (kind === "ascii") {
    const { createAsciiRuntime } = await import("./ascii.ts");
    return createAsciiRuntime(options as AsciiBoxOptions);
  }
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
    return createCloudflareRuntime(options as unknown as CloudflareBoxOptions);
  }
  if (kind === "cloudflare-computer") {
    const { createCloudflareComputerRuntime } = await import("./cloudflare-computer.ts");
    return createCloudflareComputerRuntime(options as unknown as CloudflareComputerBoxOptions);
  }
  if (kind === "vercel") {
    const { createVercelRuntime } = await import("./vercel.ts");
    return createVercelRuntime(options as VercelBoxOptions);
  }
  throw new Error(`[vitehub] Unknown Box runtime kind "${String(kind)}". Expected "ascii", "crabbox", "trusted-host", "cloudflare", "cloudflare-computer", or "vercel".`);
}

function isBoxRuntime(value: unknown): value is BoxRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Partial<BoxRuntime>;
  return typeof runtime.name === "string"
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

export async function resolveBox<Context>(
  definition: BoxDefinition<Context>,
  context: Context,
  options: ResolveBoxOptions = {},
): Promise<Box> {
  if (!definition || typeof definition !== "object")
    throw new TypeError("[vitehub] Box requires a definition.");
  const runtime = await resolveBoxRuntime(definition.runtime);
  if (definition.cwd !== undefined && definition.checkout !== undefined) {
    throw new TypeError("[vitehub] Box checkout cannot be combined with cwd.");
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
  const requirements = normalizeRequirements([
    ...(checkout ? ["git"] : []),
    ...(definition.requires || []),
    ...(options.requires || []),
  ]);
  const input: BoxRuntimeInput = {
    ...(checkout ? { checkout } : {}),
    ...(cwd ? { cwd } : {}),
    identity: planIdentity(plan, requirements, checkout),
    plan,
    requirements,
  };
  const prepared = await runtime.prepare(input);
  let executionAuthority: ExecutionAuthority;
  try {
    executionAuthority = normalizeExecutionAuthority(prepared.executionAuthority);
  } catch {
    throw new TypeError(
      `[vitehub] Box runtime ${runtime.name} must declare executionAuthority.`,
    );
  }
  const boxPlan = Object.freeze({
    ...prepared,
    executionAuthority,
    home: Object.freeze({
      state: Object.freeze(plan.state.map(state => Object.freeze({
        identity: prepared.home?.state.find(target => target.path === state.path)?.identity
          ?? createHash("sha256").update(JSON.stringify([state.key, state.path])).digest("hex"),
        path: state.path,
      }))),
    }),
  });
  return Object.freeze({
    async open(options?: BoxOpenOptions) {
      options?.signal?.throwIfAborted();
      return await runtime.open(input, {
        ...options,
        executionAuthority: boxPlan.executionAuthority,
      });
    },
    plan: boxPlan,
  });
}

function planIdentity(
  plan: ResolvedBoxPlan,
  requirements: readonly ResolvedBoxRequirementInput[],
  checkout: ResolvedBoxCheckout | undefined,
) {
  const value = JSON.stringify({
    checkout,
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
  definition: BoxDefinition<Context>,
  context: Context,
  sourceRoot: string,
): ResolvedBoxPlan {
  if (
    definition.home !== undefined &&
    (!definition.home || typeof definition.home !== "object" || Array.isArray(definition.home))
  ) {
    throw new TypeError("[vitehub] Box home must be a declarative object.");
  }
  const env = Object.fromEntries(
    Object.entries(optionalRecord(definition.env, "env")).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new TypeError(`[vitehub] Invalid Box environment variable: ${name}`);
      if (reservedEnvironment.has(name))
        throw new TypeError(`[vitehub] ${name} is managed by the Box runtime.`);
      return [
        name,
        async () => {
          const resolved = await resolveValue(value, context);
          if (resolved === undefined)
            throw new Error(`[vitehub] Box environment value ${name} is required.`);
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
        throw new TypeError(`[vitehub] Box state ${path} requires a non-empty key.`);
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
      throw new TypeError(`[vitehub] Box state keys must be unique: ${value.key}`);
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
  input: Readonly<Record<string, BoxFile<Context>>> | undefined,
  context: Context,
  label: string,
  sourceRoot: string,
): Record<string, ResolvedBoxFile> {
  const files = Object.fromEntries(
    Object.entries(optionalRecord(input, label)).map(([path, value]) => {
      const target = relativePath(path, `${label} target`);
      if (!value || typeof value !== "object")
        throw new TypeError(`[vitehub] Box file ${path} requires from or contents.`);
      if ("from" in value) {
        if (Object.keys(value).length !== 1 || typeof value.from !== "string")
          throw new TypeError(
            `[vitehub] Box file ${path} requires exactly one of from or contents.`,
          );
        const source = relativePath(value.from, `${label} source`);
        return [target, { resolve: async () => await readProjectFile(source) }];
      }
      if (!("contents" in value) || Object.keys(value).length !== 1)
        throw new TypeError(`[vitehub] Box file ${path} requires exactly one of from or contents.`);
      return [
        target,
        {
          resolve: async () => {
            const resolved = await resolveValue(value.contents, context);
            if (resolved === undefined) throw new Error(`[vitehub] Box file ${path} is required.`);
            if (typeof resolved === "string") return new TextEncoder().encode(resolved);
            if (resolved instanceof Uint8Array) return resolved;
            throw new TypeError(`[vitehub] Box file ${path} must resolve to text or bytes.`);
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
      throw new Error(`[vitehub] Box project file is unavailable: ${path}`);
    }
    return new Uint8Array(await readFile(source));
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
        throw new TypeError(
          `[vitehub] Box ${label} targets conflict: ${files[index]} and ${files[other]}`,
        );
      }
    }
  }
}

function validateTargets(files: readonly string[], state: readonly string[]) {
  for (let index = 0; index < state.length; index++) {
    for (let other = index + 1; other < state.length; other++) {
      if (isDescendant(state[index], state[other]) || isDescendant(state[other], state[index])) {
        throw new TypeError(
          `[vitehub] Box state targets overlap: ${state[index]} and ${state[other]}`,
        );
      }
    }
  }
  for (const file of files) {
    for (const directory of state) {
      if (file === directory || isDescendant(directory, file)) {
        throw new TypeError(
          `[vitehub] Box file and state targets conflict: ${file} and ${directory}`,
        );
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
    throw new TypeError(`[vitehub] Box ${label} must be an object.`);
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
    throw new TypeError(`[vitehub] Box ${label} must be a non-empty relative POSIX path.`);
  }
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new TypeError(`[vitehub] Box ${label} must be a non-empty relative POSIX path.`);
  }
  return normalized;
}

function normalizeRequirements(
  input: readonly BoxRequirement[],
): readonly ResolvedBoxRequirementInput[] {
  const requirements = input.map((value): ResolvedBoxRequirementInput => {
    if (typeof value === "string") {
      if (!value.trim())
        throw new TypeError("[vitehub] Box requirements must be non-empty commands.");
      const command = value.trim();
      if (command.includes("\0"))
        throw new TypeError("[vitehub] Box requirement commands and arguments cannot contain NUL.");
      return { args: [], command, name: command };
    }
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.command !== "string" ||
      !value.command.trim()
    ) {
      throw new TypeError("[vitehub] Box requirements must be commands or direct command checks.");
    }
    const args = value.args === undefined ? [] : [...value.args];
    if (args.some((argument) => typeof argument !== "string"))
      throw new TypeError("[vitehub] Box requirement arguments must be strings.");
    const command = value.command.trim();
    if (command.includes("\0") || args.some((argument) => argument.includes("\0")))
      throw new TypeError("[vitehub] Box requirement commands and arguments cannot contain NUL.");
    const name = value.name?.trim() || [command, ...args].join(" ");
    const timeout = value.timeout;
    if (
      timeout !== undefined
      && (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2 ** 31 - 1)
    ) {
      throw new TypeError(
        "[vitehub] Box requirement timeout must be a positive integer no greater than 2147483647ms.",
      );
    }
    return { args, command, name, ...(timeout === undefined ? {} : { timeout }) };
  });
  return [...new Map(requirements.map((value) => [JSON.stringify(value), value])).values()];
}

function resolveString(value: unknown, label: string) {
  if (typeof value !== "string" || !value)
    throw new TypeError(`[vitehub] Box ${label} must resolve to a non-empty string.`);
  if (value.includes("\0")) throw new TypeError(`[vitehub] Box ${label} cannot contain NUL.`);
  return value;
}

function resolveSha(value: unknown) {
  const sha = resolveString(value, "checkout sha").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new TypeError("[vitehub] Box checkout sha must be a full Git object id.");
  }
  return sha;
}

async function resolveValue<T, Context>(
  value: BoxValue<T, Context> | undefined,
  context: Context,
): Promise<T | undefined> {
  return typeof value === "function"
    ? await (value as (context: Context) => T | undefined | Promise<T | undefined>)(context)
    : value;
}

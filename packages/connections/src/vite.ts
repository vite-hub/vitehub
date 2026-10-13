import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path";

import * as v from "valibot";

import {
  createNoExternalAddition,
  hasNitroConfigContext,
  isServerEnvironment,
  resolveViteHubProjectRoot,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite";
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog";
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit";

import { discoverConnectionDefinitions } from "./discovery.ts";
import { withConnectionsTypesLock } from "./internal/types-lock.ts";

import type { NitroServerHandler } from "@vite-hub/internal/nitro-kit";
import type { ViteHubCliContributor } from "@vite-hub/internal/cli";
import type { Plugin, ResolvedConfig } from "vite";
import type { DiscoveredConnectionDefinition } from "./types.ts";

export const CONNECTIONS_REGISTRY_ID = "#vitehub/connections/registry";
export const CONNECTIONS_VITE_PLUGIN_NAME = "@vite-hub/connections/vite";

const resolvedConnectionsRegistryId = `\0${CONNECTIONS_REGISTRY_ID}`;
const noExternalAddition = createNoExternalAddition("@vite-hub/connections");
// Keep prior output ownership with the project so cleanup works after a restart.
const generatedTypesManifest = ".vitehub/connections-types.json";
const generatedTypesPath = ".vitehub/types/connections.d.ts";
const generatedTypesOwnersManifest = ".vitehub/connections-types-owners.json";
const generatedTypesOwnersRecoveryManifest = ".vitehub/connections-types-owners-recovery.json";
const generatedTypesManifestEntrySchema = v.object({
  root: v.string(),
  hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  owner: v.optional(v.object({
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    session: v.string(),
  })),
});
const generatedTypesOwnerSchema = v.object({
  origin: v.string(),
  hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  owner: v.object({
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    session: v.string(),
  }),
});
type GeneratedTypesOwner = v.InferOutput<typeof generatedTypesOwnerSchema>;

async function removeLegacyDefaultTypes(root: string): Promise<void> {
  const file = resolve(root, generatedTypesPath);
  const content = await readOptionalFile(file);
  if (content !== undefined && /^declare global \{\n  interface ViteHubConnectionDefinitionModules \{\n(?:    "[^\n]+": typeof import\("[^\n]+"\)\n)*  \}\n\}\n\nexport \{\}\n$/.test(content) && (await lstat(file)).isFile()) {
    await rm(file, { force: true });
  }
}

function typeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function withManifestLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return await withConnectionsTypesLock(resolve(root, `${generatedTypesManifest}.lock`), action);
}

async function withOwnersLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return await withConnectionsTypesLock(resolve(root, `${generatedTypesOwnersManifest}.lock`), action);
}

async function readTypesManifest<T>(root: string, manifest: string, schema: v.GenericSchema<unknown, T>): Promise<T[] | undefined> {
  const content = await readOptionalFile(resolve(root, manifest));
  if (content === undefined) return;
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const parsed = v.safeParse(v.array(schema), Array.isArray(input) ? input : [input]);
  return parsed.success ? parsed.output : undefined;
}

async function readManifest(root: string) {
  return await readTypesManifest(root, generatedTypesManifest, generatedTypesManifestEntrySchema);
}

async function readOwners(root: string) {
  const recovery = await readTypesManifest(root, generatedTypesOwnersRecoveryManifest, generatedTypesOwnerSchema);
  if (recovery !== undefined) return recovery;
  return await readTypesManifest(root, generatedTypesOwnersManifest, generatedTypesOwnerSchema);
}

async function writeOwners(root: string, owners: GeneratedTypesOwner[]): Promise<void> {
  // Keep the complete shared owner list recoverable without scanning other app roots.
  // Publish recovery first and select it first. If the process exits before the
  // primary copy is replaced, readers still see the complete new owner list.
  await writeTypesManifest(root, generatedTypesOwnersRecoveryManifest, owners);
  await writeTypesManifest(root, generatedTypesOwnersManifest, owners);
}

async function removeOwners(root: string): Promise<void> {
  await rm(resolve(root, generatedTypesOwnersManifest), { force: true });
  await rm(resolve(root, generatedTypesOwnersRecoveryManifest), { force: true });
}

type GeneratedTypesEntry = v.InferOutput<typeof generatedTypesManifestEntrySchema>;

async function writeTypesManifest<T>(root: string, path: string, entries: T[]): Promise<void> {
  const manifest = resolve(root, path);
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entries));
    await rename(temporary, manifest);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeUntrackedDefaultTypes(root: string): Promise<void> {
  await removeGeneratedOwner(root, root);
}

async function removeGeneratedOwner(target: string, origin: string): Promise<void> {
  await withOwnersLock(target, async () => {
    const owners = await readOwners(target);
    if (!owners) return;
    const remaining = owners.filter(entry => resolve(target, entry.origin) !== resolve(target, origin));
    const removed = owners.filter(entry => !remaining.includes(entry));
    const file = resolve(target, generatedTypesPath);
    const previous = await readOptionalFile(file);
    if (remaining.length) {
      await writeOwners(target, remaining);
    } else {
      if (owners.length === 0) await removeLegacyDefaultTypes(target);
      if (previous !== undefined && removed.some(entry => typeHash(previous) === entry.hash) && (await lstat(file)).isFile()) {
        await rm(file, { force: true });
      }
      await removeOwners(target);
    }
    const tracked = await readManifest(target);
    if (tracked) {
      const retained = tracked.filter(entry => resolve(target, entry.root) !== resolve(target, origin));
      if (retained.length) await writeTypesManifest(target, generatedTypesManifest, retained);
      else await rm(resolve(target, generatedTypesManifest), { force: true });
    }
  });
}

function isOtherProcessActive(entry: Pick<GeneratedTypesEntry, "owner">): boolean {
  if (!entry.owner || entry.owner.pid === process.pid) return false;
  try {
    process.kill(entry.owner.pid, 0);
    return true;
  } catch (error) {
    // Only a confirmed exit allows cleanup. Permission failures preserve ownership.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function removeTrackedTypes(root: string): Promise<void> {
  const entries = await readManifest(root);
  if (!entries) return;
  const retained: GeneratedTypesEntry[] = [];
  const targets = new Set(entries.map(entry => resolve(root, entry.root)));
  for (const target of targets) {
    await withOwnersLock(target, async () => {
      const owners = await readOwners(target);
      const file = resolve(target, generatedTypesPath);
      const previous = await readOptionalFile(file);
      if (!owners || (owners.length === 0 && previous !== undefined)) {
        // Without shared ownership evidence, a tracked file may belong to another app.
        retained.push(...entries.filter(entry => resolve(root, entry.root) === target));
        return;
      }
      const remaining = owners.filter(entry => resolve(target, entry.origin) !== root || isOtherProcessActive(entry));
      const removed = owners.filter(entry => !remaining.includes(entry));
      if (remaining.length) {
        await writeOwners(target, remaining);
        const currentOwners = remaining.filter(entry => resolve(target, entry.origin) === root);
        retained.push(...entries.filter(entry => resolve(root, entry.root) === target
          && currentOwners.some(owner => owner.owner.session === entry.owner?.session)));
      } else {
        if (previous !== undefined && removed.some(entry => typeHash(previous) === entry.hash) && (await lstat(file)).isFile()) {
          await rm(file, { force: true });
        }
        await removeOwners(target);
      }
    });
  }
  if (retained.length) await writeTypesManifest(root, generatedTypesManifest, retained);
  else await rm(resolve(root, generatedTypesManifest), { force: true });
}

function storedTypesRoot(root: string, target: string): string {
  // Same-volume roots remain portable; cross-volume Windows roots must stay absolute.
  const relativeRoot = relative(root, target);
  return isAbsolute(relativeRoot) ? target : relativeRoot;
}

async function recordGeneratedTypes(root: string, projectRoot: string, hash: string, session: string): Promise<void> {
  const entries = await readManifest(root) ?? [];
  await writeTypesManifest(root, generatedTypesManifest, [
    ...entries.filter(entry => !(resolve(root, entry.root) === projectRoot && entry.owner?.session === session)),
    { root: storedTypesRoot(root, projectRoot), hash, owner: { pid: process.pid, session } },
  ]);
}

async function recordGeneratedOwners(projectRoot: string, origin: string, hash: string, session: string, entries: GeneratedTypesOwner[]): Promise<void> {
  await writeOwners(projectRoot, [
    // Every owner shares the declaration currently on disk, including a later writer's content.
    ...entries.filter(entry => !(resolve(projectRoot, entry.origin) === origin && entry.owner.session === session))
      .map(entry => ({ ...entry, hash })),
    { origin: storedTypesRoot(projectRoot, origin), hash, owner: { pid: process.pid, session } },
  ]);
}

export interface ConnectionsVitePluginOptions {
  /**
   * Module whose default export is the access policy of the management API, in development and
   * production. Export a function that authenticates the `Request` and returns `user:<id>`, or
   * `undefined` to deny it. Export `"development"` to allow the development server without Auth.
   * Without this module, development uses `"development"`.
   */
  actor?: string;
  /** Module that exports the ViteHub Database as `db`. Set `false` when the app has no database. */
  database?: string | false;
  /** Package that the generated handler imports from. */
  importBase?: string;
  /**
   * Mount the management API in production. The development server always mounts it.
   * Production requires an actor module, from `actor` or `management.actor`.
   */
  management?: boolean | { actor: string };
  projectRoot?: string;
}

export interface ConnectionsVitePluginAPI {
  prepareTypes: (options: { projectRoot: string, serverDirs?: string[] }) => Promise<void>
  getDefinitions: () => DiscoveredConnectionDefinition[];
  refresh: () => DiscoveredConnectionDefinition[];
}

export type ConnectionsVitePlugin = Plugin<ConnectionsVitePluginAPI> & {
  api: ConnectionsVitePluginAPI;
  vitehub: { cli: () => Promise<ViteHubCliContributor> };
  nitro: {
    name: string;
    setup: (nitro: { options: { handlers: NitroServerHandler[] }; routing: { sync: () => void } }) => void;
  };
};

function renderRegistry(
  definitions: DiscoveredConnectionDefinition[],
  database: string | false,
): string {
  return [
    "const registry = Object.create(null)",
    ...definitions.map(
      (definition) =>
        `registry[${JSON.stringify(definition.name)}] = () => import(${JSON.stringify(definition.handler)})`,
    ),
    "",
    database
      ? `export const database = () => import(${JSON.stringify(database)}).then(module => module.db)`
      : "export const database = undefined",
    "export default registry",
    "",
  ].join("\n");
}

function renderRegistryTypes(definitions: DiscoveredConnectionDefinition[]): string {
  return [
    "// Generated by @vite-hub/connections. Do not edit.",
    "declare global {",
    "  interface ViteHubConnectionDefinitionModules {",
    ...definitions.map(
      (definition) =>
        `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`,
    ),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n");
}

function connectionMountBase(base: unknown): string {
  const parsed = v.safeParse(v.pipe(v.string(), v.regex(/^\/(?!\/)/)), base);
  return parsed.success ? parsed.output.replace(/\/+$/, "") : "";
}

function connectionManagementRoute(base: unknown): string {
  return `${connectionMountBase(base)}/_vitehub/connections`
}

function isConnectionDefinitionFile(
  file: string,
  projectRoot: string,
  serverDirs: string[] | undefined,
): boolean {
  const normalized = resolve(file).replace(/\\/g, "/");
  if (/\.connection\.(?:c|m)?[jt]s$/i.test(normalized)) return true;
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const connectionDirectory = `${resolve(directory, "connections").replace(/\\/g, "/")}/`;
    return normalized.startsWith(connectionDirectory) && /\.(?:[jt]sx?|[cm][jt]s)$/i.test(normalized);
  });
}

export function hubConnections(options: ConnectionsVitePluginOptions = {}): ConnectionsVitePlugin {
  const importBase = options.importBase ?? "@vite-hub/connections";
  const database = options.database ?? false;
  let resolved: ResolvedConfig | undefined;
  let definitions: DiscoveredConnectionDefinition[] = [];
  let serverDirs: string[] | undefined;
  let defaultProjectRoot = resolveViteHubProjectRoot(process.cwd())
  let projectRoot = process.cwd();
  const generationSession = randomUUID();
  let nitroRegistryFile: string | undefined;
  let nitroInstance: Parameters<ConnectionsVitePlugin["nitro"]["setup"]>[0] | undefined;
  let refreshManagement: ((config: ResolvedConfig) => Promise<void>) | undefined;

  function refresh(): DiscoveredConnectionDefinition[] {
    defaultProjectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()))
    projectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()), { projectRoot: options.projectRoot });
    definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs });
    return definitions;
  }

  async function refreshGeneratedFiles(): Promise<void> {
    await withManifestLock(defaultProjectRoot, async () => {
      if (projectRoot !== defaultProjectRoot) await removeUntrackedDefaultTypes(defaultProjectRoot);
      await withOwnersLock(projectRoot, async () => {
        let owners = await readOwners(projectRoot);
        const hadTypes = await readOptionalFile(resolve(projectRoot, generatedTypesPath)) !== undefined;
        if ((!owners || owners.length === 0) && hadTypes) {
          // A missing or malformed owner manifest may contain owners from other
          // app roots. Preserve the declaration and leave ownership unknown so
          // cleanup cannot remove output that another app still uses.
          const types = renderRegistryTypes(definitions);
          await Promise.all([
            writeFileIfChanged(resolve(projectRoot, generatedTypesPath), types),
            ...(nitroRegistryFile ? [writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions, database))] : []),
          ]);
          await recordGeneratedTypes(defaultProjectRoot, projectRoot, typeHash(types), generationSession);
          return;
        }
        if (!owners) {
          const tracked = await readManifest(defaultProjectRoot);
          owners = (tracked ?? [])
            .filter(entry => resolve(defaultProjectRoot, entry.root) === projectRoot && entry.owner)
            .map(entry => ({
              origin: storedTypesRoot(projectRoot, defaultProjectRoot),
              hash: entry.hash,
              owner: entry.owner!,
            }));
        }
        const types = renderRegistryTypes(definitions);
        await Promise.all([
          writeFileIfChanged(resolve(projectRoot, generatedTypesPath), types),
          ...(nitroRegistryFile ? [writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions, database))] : []),
        ]);
        await recordGeneratedOwners(projectRoot, defaultProjectRoot, typeHash(types), generationSession, owners);
        await recordGeneratedTypes(defaultProjectRoot, projectRoot, typeHash(types), generationSession);
      });
    });
  }

  return {
    name: CONNECTIONS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      async prepareTypes(input) {
        defaultProjectRoot = resolveViteHubProjectRoot(input.projectRoot)
        projectRoot = resolveViteHubProjectRoot(input.projectRoot, { projectRoot: options.projectRoot })
        serverDirs = input.serverDirs
        definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs })
        await refreshGeneratedFiles()
      },
      getDefinitions: () => definitions,
      refresh,
    },
    nitro: {
      name: "@vite-hub/connections/management",
      setup(nitro) {
        nitroInstance = nitro;
      },
    },
    vitehub: {
      cli: async () => {
        const { createConnectionsCliContributor } = await import("./cli.ts");
        return createConnectionsCliContributor();
      },
    },
    async config(config, environment) {
      serverDirs =
        v.parse(v.optional(v.array(v.string())), Reflect.get(config, VITEHUB_SERVER_DIRS)) ??
        serverDirs;
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: noExternalAddition(config.ssr?.noExternal) },
      };
      if (!hasNitroConfigContext(config)) return nextConfig;

      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), {
        projectRoot: options.projectRoot,
      });
      const generatedDir = resolve(root, ".vitehub", "nitro", "connections");
      nitroRegistryFile = resolve(generatedDir, "registry.ts");
      const handlerFile = resolve(generatedDir, "handler.ts");
      await writeFileIfChanged(
        nitroRegistryFile,
        renderRegistry(discoverConnectionDefinitions({ rootDir: root, serverDirs }), database),
      );

      const nitroInput: unknown = Reflect.get(config, "nitro");
      const nitro = v.parse(
        v.looseObject({
          alias: v.optional(v.record(v.string(), v.unknown()), {}),
          externals: v.optional(
            v.looseObject({
              inline: v.optional(v.union([v.literal(true), v.array(v.unknown())]), []),
            }),
            {},
          ),
        }),
        nitroInput ?? {},
      );
      const alias = nitro.alias;
      const externals = nitro.externals;
      const inline =
        externals.inline === true
          ? true
          : [
              ...new Set([
                ...(Array.isArray(externals.inline) ? externals.inline : []),
                "vite-hub",
                "@vite-hub/connections",
              ]),
            ];
      nitro.alias = { ...alias, [CONNECTIONS_REGISTRY_ID]: nitroRegistryFile };
      nitro.externals = { ...externals, inline };

      if (environment.command === "serve" || options.management) {
        const actorModule =
          (options.management && options.management !== true ? options.management.actor : undefined) ?? options.actor;
        if (environment.command !== "serve" && !actorModule?.trim()) {
          throw new Error(
            "Connections management in production requires management: { actor: <authentication module> }.",
          );
        }
        const actorImport = actorModule?.startsWith(".") ? resolve(root, actorModule) : actorModule;
        const writeManagementHandler = async (managementRoute: string) => await writeFileIfChanged(
          handlerFile,
          [
            `import { createConnectionsHandler } from ${JSON.stringify(`${importBase}/server`)}`,
            `import type { IncomingMessage } from "node:http"`,
            "",
            ...(actorModule ? [`import actor from ${JSON.stringify(actorImport)}`] : []),
            "",
            // Without an actor module, only a development server allows management.
            actorModule
              ? `const handle = createConnectionsHandler({ actor, basePath: ${JSON.stringify(managementRoute)} })`
              : `const handle = createConnectionsHandler({ actor: "development", basePath: ${JSON.stringify(managementRoute)} })`,
            "",
            "export default (event: { req?: Request, node?: { req?: IncomingMessage & { socket: { encrypted?: boolean } } } }) => {",
            "  const raw = event.req ?? event.node?.req",
            "  if (!raw) return handle(new Request('http://localhost/'), event)",
            "  if (raw instanceof Request) return handle(raw, event)",
            "  const headers = new Headers()",
            "  for (const [name, value] of Object.entries(raw.headers ?? {})) { if (typeof value === 'string') headers.set(name, value); else if (Array.isArray(value)) for (const item of value) headers.append(name, item) }",
            "  const firstHeader = (name: string) => headers.get(name)?.split(',')[0]?.trim()",
            "  const host = firstHeader('x-forwarded-host') ?? firstHeader('host') ?? 'localhost'",
            "  const protocol = firstHeader('x-forwarded-proto') ?? (raw.socket?.encrypted ? 'https' : 'http')",
            "  const method = raw.method ?? 'GET'",
            "  const init: RequestInit & { duplex?: 'half' } = { method, headers }",
            "  if (method !== 'GET' && method !== 'HEAD') {",
            "    const iterator = raw[Symbol.asyncIterator]()",
            "    init.body = new ReadableStream({ async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value) } catch (error) { controller.error(error) } } })",
            "    init.duplex = 'half'",
            "  }",
            "  const request = new Request(new URL(raw.url ?? '/', `${protocol === 'https' ? 'https' : 'http'}://${host}`), init)",
            "  return handle(request, event)",
            "}",
            "",
          ].join("\n"),
        );
        const managementRoute = connectionManagementRoute(Reflect.get(config, "base"));
        await writeManagementHandler(managementRoute);
        refreshManagement = async (config) => {
          const route = connectionManagementRoute(config.base);
          const updateHandlers = (value: unknown) => {
            const kit = createNitroServerKit(value);
            if (Array.isArray(kit.config.handlers)) {
              kit.config.handlers.splice(0, kit.config.handlers.length, ...kit.config.handlers.filter(handler =>
                !v.is(v.looseObject({ handler: v.literal(handlerFile) }), handler),
              ));
            }
            kit.addHandler({ handler: handlerFile, route });
            kit.addHandler({ handler: handlerFile, route: `${route}/**` });
            return kit.config;
          };
          Reflect.set(config, "nitro", updateHandlers(Reflect.get(config, "nitro")));
          // Nitro initializes during config hooks, before Vite resolves its final base.
          if (nitroInstance) {
            Object.assign(nitroInstance.options, updateHandlers(nitroInstance.options));
            nitroInstance.routing.sync();
          }
          await writeManagementHandler(route);
        };
        const kit = createNitroServerKit(nitro);
        kit.addHandler({ handler: handlerFile, route: managementRoute });
        kit.addHandler({ handler: handlerFile, route: `${managementRoute}/**` });
        Object.assign(nitro, kit.config);
      }
      Reflect.set(config, "nitro", nitro);
      return nextConfig;
    },
    async configResolved(config) {
      resolved = config;
      await refreshManagement?.(config);
      refresh();
      await refreshGeneratedFiles();
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return;
      return {
        resolve: { noExternal: noExternalAddition(config.resolve?.noExternal) },
      };
    },
    async handleHotUpdate(context) {
      if (!isConnectionDefinitionFile(context.file, projectRoot, serverDirs)) return;
      resolved = context.server.config;
      refresh();
      await refreshGeneratedFiles();
      const module = context.server.moduleGraph.getModuleById(resolvedConnectionsRegistryId);
      if (module) context.server.moduleGraph.invalidateModule(module);
    },
    resolveId(id) {
      if (id === CONNECTIONS_REGISTRY_ID) return resolvedConnectionsRegistryId;
    },
    load(id) {
      if (id === resolvedConnectionsRegistryId) return renderRegistry(definitions, database);
    },
  };
}

/** Remove declarations when a host disables Connections. */
export function hubConnectionsTypesCleanup(): Plugin<{ prepareTypes: (options: { projectRoot: string }) => Promise<void> }> {
  const prepareTypes = async (options: { projectRoot: string }): Promise<void> => {
    const root = resolveViteHubProjectRoot(options.projectRoot)
    await withManifestLock(root, async () => {
      const tracked = await readOptionalFile(resolve(root, generatedTypesManifest));
      await removeTrackedTypes(root);
      if (tracked === undefined) await removeUntrackedDefaultTypes(root);
    });
  }
  return {
    name: "@vite-hub/connections/types-cleanup",
    enforce: "pre",
    api: { prepareTypes },
    config: config => prepareTypes({ projectRoot: resolveViteHubProjectRoot(resolve(config.root || process.cwd())) }),
    configResolved: config => prepareTypes({ projectRoot: resolveViteHubProjectRoot(config.root) }),
  }
}

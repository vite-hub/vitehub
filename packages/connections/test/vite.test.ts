import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VITEHUB_APP_BASE_URL, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PREPARE } from "@vite-hub/internal/build/vite";
import { mergeConfig, resolveConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverConnectionDefinitions } from "../src/discovery.ts";
import { CONNECTIONS_REGISTRY_ID, hubConnections, hubConnectionsTypesCleanup } from "../src/vite.ts";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-vite-"));
  tempDirs.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  return root;
}

async function writeConnection(root: string, path: string): Promise<string> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "export default {}\n");
  return file;
}

type ConfigHook = (
  config: Record<PropertyKey, unknown>,
  environment: { command: "build" | "serve"; mode: string },
) => Promise<Record<string, unknown>>;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("discoverConnectionDefinitions", () => {
  it("finds server/connections files and .connection suffix files", async () => {
    const root = await createTempProject();
    const google = await writeConnection(root, "server/connections/google.ts");
    const slack = await writeConnection(root, "src/slack.connection.ts");
    const nested = await writeConnection(root, "server/connections/team/mail.ts");
    expect(discoverConnectionDefinitions({ rootDir: root })).toEqual([
      { handler: google, name: "google", source: "server-connections" },
      { handler: slack, name: "slack", source: "vite-suffix" },
      { handler: nested, name: "team/mail", source: "server-connections" },
    ]);
  });
});

describe("hubConnections", () => {
  it("filters resolveId and load to the Connections registry", () => {
    const plugin = hubConnections();
    const resolveFilter = (plugin.resolveId as { filter: { id: RegExp } }).filter.id;
    const loadFilter = (plugin.load as { filter: { id: RegExp } }).filter.id;

    expect([CONNECTIONS_REGISTRY_ID, `${CONNECTIONS_REGISTRY_ID}.ts`, "@vite-hub/connections"].map(id => resolveFilter.test(id))).toEqual([true, false, false]);
    expect([`\0${CONNECTIONS_REGISTRY_ID}`, CONNECTIONS_REGISTRY_ID].map(id => loadFilter.test(id))).toEqual([true, false]);
  });

  it("asks @vite-hub/database for the default SQLite Database when it has a Database module", () => {
    expect(hubConnections({ database: "vite-hub/database/drizzle" }).vitehub.databases()).toEqual([
      { database: "default", dialect: "sqlite", name: "connections", reason: "Stores Connection grants, approvals, and activity." },
    ]);
    expect(hubConnections().vitehub.databases()).toEqual([]);
  });

  it.each(["users", "billing/archive", "audit.logs", "1users", "Team_1/archive-2"])("keeps Connection data in the %s Database", async (databaseName) => {
    const plugin = hubConnections({ database: "vite-hub/database/drizzle", databaseName });
    expect(plugin.vitehub.databases()).toEqual([
      { database: databaseName, dialect: "sqlite", name: "connections", reason: "Stores Connection grants, approvals, and activity." },
    ]);
    const root = await createTempProject();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (plugin.config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
    const nitro = config.nitro as { alias: Record<string, string> };
    await expect(readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8")).resolves.toContain(
      `export const database = () => import("vite-hub/database/drizzle").then(module => module.databases[${JSON.stringify(databaseName)}].db)`,
    );
  });

  it.each(["", "../users", "users/", "/users", "users//archive", "audit logs", "users\"); x("])("rejects the invalid Database name %j before generation", (databaseName) => {
    expect(() => hubConnections({ databaseName })).toThrow("connections.database must be a Database name");
  });

  it.each(["@vite-hub/connections", "vite-hub/connections"])("writes the registry and mounts the management API through %s in development", async (importBase) => {
    const root = await createTempProject();
    const definition = await writeConnection(root, "server/connections/google.ts");
    const plugin = hubConnections({ database: "vite-hub/database/drizzle", importBase });
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (plugin.config as unknown as ConfigHook)(config, {
      command: "serve",
      mode: "development",
    });
    const nitro = config.nitro as {
      alias: Record<string, string>;
      handlers: Array<{ handler: string; method?: string; route: string }>;
    };
    const registry = await readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8");
    expect(registry).toContain(JSON.stringify(definition));
    expect(registry).toContain(
      'export const database = () => import("vite-hub/database/drizzle").then(module => module.db)',
    );
    expect(nitro.handlers.map((handler) => handler.route)).toEqual([
      "/_vitehub/connections",
      "/_vitehub/connections/connect/**",
      "/_vitehub/connections/callback",
    ]);
    // A GET of the management path stays free for the Console Connections page.
    expect(nitro.handlers.map((handler) => handler.method)).toEqual(["post", "get", "get"]);
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain(
      `from "${importBase}/server"`,
    );
  });

  it("inlines a linked @vite-hub/connections in Nitro so it reads the generated registry", async () => {
    const root = await createTempProject();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
    const { inline } = (config.nitro as { externals: { inline: unknown[] } }).externals;
    // In this workspace the package resolves outside node_modules, like any linked package. Nitro 2 matches inline
    // strings against the path and against the part after the last `node_modules/`.
    const file = fileURLToPath(import.meta.resolve("@vite-hub/connections/server"));
    const nitroMatches = (pattern: string) => file.startsWith(pattern) || file.split("node_modules/").pop()!.startsWith(pattern);
    expect(nitroMatches("@vite-hub/connections")).toBe(false);
    expect(inline.some(entry => typeof entry === "string" && nitroMatches(entry))).toBe(true);
  });

  it("hands the registry to the package that Node loads in vite dev", async () => {
    for (const command of ["serve", "build"] as const) {
      const root = await createTempProject();
      const plugin = hubConnections({ importBase: "vite-hub/connections" });
      const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
      await (plugin.config as unknown as ConfigHook)(config, { command, mode: "development" });
      const registryPlugin = join(root, ".vitehub/nitro/connections/registry-dev-plugin.ts");
      const plugins = (config.nitro as { plugins?: string[] }).plugins ?? [];
      const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: string }, env: { command: string }) => unknown;
      if (command === "serve") {
        expect(plugins).toEqual([registryPlugin]);
        await expect(readFile(registryPlugin, "utf8")).resolves.toContain([
          'import { installConnectionsRegistry as viteHubInstall0 } from "vite-hub/connections/server"',
          'import * as viteHubModule0 from "./registry.ts"',
        ].join("\n"));
        expect(configEnvironment("nitro", { consumer: "server" }, { command })).toBeUndefined();
      }
      else {
        expect(plugins).toEqual([]);
        expect(configEnvironment("nitro", { consumer: "server" }, { command })).toEqual({ resolve: { noExternal: ["@vite-hub/connections"] } });
      }
    }
  });

  it("writes the resolved activity retention into the registry", async () => {
    const registryFor = async (activityRetention?: { maxAgeMs?: number, maxRecords?: number } | false) => {
      const root = await createTempProject();
      const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
      await (hubConnections({ activityRetention }).config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
      return readFile((config.nitro as { alias: Record<string, string> }).alias[CONNECTIONS_REGISTRY_ID]!, "utf8");
    };
    await expect(registryFor()).resolves.toContain('export const activityRetention = {"maxAgeMs":1209600000,"maxRecords":10000}');
    await expect(registryFor({ maxRecords: 50 })).resolves.toContain('export const activityRetention = {"maxAgeMs":1209600000,"maxRecords":50}');
    await expect(registryFor(false)).resolves.toContain("export const activityRetention = false");
  });

  it("writes the Markdown next to each definition file into the registry", async () => {
    const root = await createTempProject();
    await writeConnection(root, "server/connections/github.ts");
    await writeConnection(root, "server/connections/slack.ts");
    await writeConnection(root, "src/linear.connection.ts");
    await writeFile(join(root, "server/connections/github.md"), "Connect the **bot** account.\n");
    await writeFile(join(root, "src/linear.connection.md"), "Use the team workspace.\n");
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(config, { command: "build", mode: "production" });
    const registry = await readFile((config.nitro as { alias: Record<string, string> }).alias[CONNECTIONS_REGISTRY_ID]!, "utf8");
    expect(registry).toContain(`docs["github"] = () => import(${JSON.stringify(join(root, "server/connections/github.md?raw"))}).then(module => module.default)`);
    expect(registry).toContain(`docs["linear"] = () => import(${JSON.stringify(join(root, "src/linear.connection.md?raw"))}).then(module => module.default)`);
    expect(registry).not.toContain('docs["slack"]');
    expect(discoverConnectionDefinitions({ rootDir: root }).map(definition => definition.name).sort()).toEqual(["github", "linear", "slack"]);
  });

  it.each([{ maxRecords: 0 }, { maxAgeMs: -1 }, { maxRecords: 1.5 }, { maxAgeMs: Number.MAX_SAFE_INTEGER + 1 }])("rejects activity retention %j when the plugin is created", (activityRetention) => {
    expect(() => hubConnections({ activityRetention })).toThrow(/activityRetention\.max(AgeMs|Records) must be a positive integer/);
  });

  it("mounts the management API under the configured Vite base", async () => {
    const root = await createTempProject();
    const config = { base: "/portal/", nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(config, {
      command: "serve",
      mode: "development",
    });

    const nitro = config.nitro as {
      handlers: Array<{ handler: string; route: string }>;
    };
    expect(nitro.handlers.map((handler) => handler.route)).toEqual([
      "/portal/_vitehub/connections",
      "/portal/_vitehub/connections/connect/**",
      "/portal/_vitehub/connections/callback",
    ]);
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain(
      'basePath: "/portal/_vitehub/connections"',
    );
  });

  it("mounts management routes from the final resolved Vite base", async () => {
    const root = await createTempProject();
    const connections = hubConnections();
    const initializedNitro = { options: { handlers: [] as Array<{ handler: string; route: string }> }, routing: { sync: vi.fn() } };
    const config = await resolveConfig({
      root,
      configFile: false,
      base: "/early/",
      plugins: [
        { name: "nitro-context", enforce: "pre", config: config => {
          Reflect.set(config, VITEHUB_NITRO_CONFIG_CONTEXT, true);
          Reflect.set(config, "nitro", { handlers: [{ handler: "existing.ts", route: "/existing" }] });
        } },
        connections,
        { name: "initialize-nitro", config: config => {
          initializedNitro.options = structuredClone(Reflect.get(config, "nitro"));
          connections.nitro.setup(initializedNitro);
        } },
        { name: "change-base", config: () => ({ base: "/portal/" }) },
      ],
    }, "serve", "development");
    const nitro = Reflect.get(config, "nitro") as {
      handlers: Array<{ handler: string; route: string }>;
    };
    expect(nitro.handlers.map(handler => handler.route)).toEqual([
      "/existing",
      "/portal/_vitehub/connections",
      "/portal/_vitehub/connections/connect/**",
      "/portal/_vitehub/connections/callback",
    ]);
    expect(initializedNitro.options.handlers).toEqual(nitro.handlers);
    expect(initializedNitro.routing.sync).toHaveBeenCalledOnce();
    const handler = await readFile(nitro.handlers[1]!.handler, "utf8");
    expect(handler).toContain('basePath: "/portal/_vitehub/connections"');
    expect(handler).not.toContain("/early/");
  });

  it("updates the handlers of a Nitro 2 instance at the Nuxt app base, not the assets base", async () => {
    const root = await createTempProject();
    const connections = hubConnections();
    const initializedNitro = { options: { handlers: [] as Array<{ handler: string; route: string }> } };
    // Nuxt serves Vite assets from /_nuxt/ and passes its app base separately.
    const nuxtBase = { base: "/_nuxt/", [VITEHUB_APP_BASE_URL]: "/" };
    const config = await resolveConfig({
      root,
      configFile: false,
      ...nuxtBase,
      plugins: [
        { name: "nitro-context", enforce: "pre", config: config => {
          Reflect.set(config, VITEHUB_NITRO_CONFIG_CONTEXT, true);
          Reflect.set(config, "nitro", { handlers: [] });
        } },
        connections,
        { name: "initialize-nitro", config: config => {
          initializedNitro.options = structuredClone(Reflect.get(config, "nitro"));
          connections.nitro.setup(initializedNitro);
        } },
      ],
    }, "serve", "development");
    expect(initializedNitro.options.handlers).toEqual(Reflect.get(config, "nitro").handlers);
    expect(initializedNitro.options.handlers.map(handler => handler.route)).toEqual([
      "/_vitehub/connections",
      "/_vitehub/connections/connect/**",
      "/_vitehub/connections/callback",
    ]);
  });

  it("generates management output during Nuxt prepare without a production actor", async () => {
    const root = await createTempProject();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true, [VITEHUB_PREPARE]: true };
    await (hubConnections({ management: true }).config as unknown as ConfigHook)(config, {
      command: "build",
      mode: "production",
    });
    const handlers = (config.nitro as { handlers: Array<{ handler: string }> }).handlers;
    expect(handlers).toHaveLength(3);
    await expect(readFile(handlers[0]!.handler, "utf8")).resolves.toContain(
      'createConnectionsHandler({ actor: "development", basePath: "/_vitehub/connections" })',
    );
  });

  it("requires authenticated management configuration in production", async () => {
    const root = await createTempProject();
    const build = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(build, {
      command: "build",
      mode: "production",
    });
    expect((build.nitro as { handlers?: unknown[] }).handlers ?? []).toEqual([]);
    await expect(
      (hubConnections({ management: true }).config as unknown as ConfigHook)(
        { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true },
        { command: "build", mode: "production" },
      ),
    ).rejects.toMatchObject({ code: "CONNECTIONS_AUTH_REQUIRED", fix: expect.stringContaining("management: { actor") });
    const managed = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (
      hubConnections({ management: { actor: "./server/connections-auth.ts" } })
        .config as unknown as ConfigHook
    )(managed, { command: "build", mode: "production" });
    const handlers = (managed.nitro as { handlers: Array<{ handler: string }> }).handlers;
    expect(handlers).toHaveLength(3);
    const handler = await readFile(handlers[0]!.handler, "utf8");
    expect(handler).toContain(
      `import actor from ${JSON.stringify(join(root, "server/connections-auth.ts"))}`,
    );
    expect(handler).toContain('export default createConnectionsHandler({ actor, basePath: "/_vitehub/connections" })');
    expect(handler).not.toContain("user:local");
  });

  it("exports the Fetchable handler and imports nothing from h3 or nitro", async () => {
    const root = await createTempProject();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
    const handlers = (config.nitro as { handlers: Array<{ handler: string }> }).handlers;
    const source = await readFile(handlers[0]!.handler, "utf8");
    expect(source).toContain('export default createConnectionsHandler({ actor: "development", basePath: "/_vitehub/connections" })');
    expect(source).not.toMatch(/from "(h3|nitro)/);
    expect(source).not.toContain("event");
  });

  it("checks every development request with the actor module, or the development policy without one", async () => {
    const handlerFor = async (plugin: ReturnType<typeof hubConnections>, command: "build" | "serve") => {
      const root = await createTempProject();
      const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
      await (plugin.config as unknown as ConfigHook)(config, { command, mode: command === "serve" ? "development" : "production" });
      const handlers = (config.nitro as { handlers: Array<{ handler: string }> }).handlers;
      return await readFile(handlers[0]!.handler, "utf8");
    };
    const local = await handlerFor(hubConnections(), "serve");
    expect(local).toContain('createConnectionsHandler({ actor: "development", basePath: "/_vitehub/connections" })');
    expect(local).not.toContain("user:local");

    const authenticated = await handlerFor(hubConnections({ actor: "#app/connections-actor" }), "serve");
    expect(authenticated).toContain('import actor from "#app/connections-actor"');
    expect(authenticated).toContain('createConnectionsHandler({ actor, basePath: "/_vitehub/connections" })');

    const production = await handlerFor(hubConnections({ actor: "#app/connections-actor", management: true }), "build");
    expect(production).toContain('import actor from "#app/connections-actor"');
    const explicit = await handlerFor(hubConnections({ actor: "#app/connections-actor", management: { actor: "#app/managers" } }), "build");
    expect(explicit).toContain('import actor from "#app/managers"');
  });

  it("preserves existing config arrays when Vite merges the hook result", async () => {
    const root = await createTempProject();
    const config = {
      nitro: { handlers: [{ handler: "existing.ts", route: "/existing" }] },
      root,
      ssr: { noExternal: ["existing-package"] },
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    };
    const addition = await (hubConnections().config as unknown as ConfigHook)(config, {
      command: "serve",
      mode: "development",
    });
    const merged = mergeConfig(config, addition);
    expect(merged.ssr.noExternal).toEqual(["existing-package", "@vite-hub/connections"]);
    expect(merged.nitro.handlers.map((handler: { route: string }) => handler.route)).toEqual([
      "/existing",
      "/_vitehub/connections",
      "/_vitehub/connections/connect/**",
      "/_vitehub/connections/callback",
    ]);
  });

  it.each(["server/connections/github.ts", "src/github.connection.ts"])("refreshes docs when Markdown next to %s is added and deleted", async (definitionPath) => {
    const root = await createTempProject();
    const definition = await writeConnection(root, definitionPath);
    const docsFile = definition.replace(/\.ts$/, ".md");
    const plugin = hubConnections();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (plugin.config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root });
    const registryFile = (config.nitro as { alias: Record<string, string> }).alias[CONNECTIONS_REGISTRY_ID]!;
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
    const httpServer = new EventEmitter();
    const module = {};
    const invalidateModule = vi.fn();
    const logger = { error: vi.fn() };
    const server = {
      config: { root, logger },
      httpServer,
      moduleGraph: { getModuleById: () => module, invalidateModule },
      watcher,
    };
    await (plugin.configureServer as (server: unknown) => void)(server);
    await expect(readFile(registryFile, "utf8")).resolves.not.toContain('docs["github"]');

    await writeFile(docsFile, "Connect the team account.\n");
    watcher.emit("add", docsFile);
    await vi.waitFor(async () => {
      expect(invalidateModule).toHaveBeenCalledWith(module);
      await expect(readFile(registryFile, "utf8")).resolves.toContain(JSON.stringify(`${docsFile}?raw`));
    });

    invalidateModule.mockClear();
    await rm(docsFile);
    watcher.emit("unlink", docsFile);
    await vi.waitFor(async () => {
      expect(invalidateModule).toHaveBeenCalledWith(module);
      await expect(readFile(registryFile, "utf8")).resolves.not.toContain('docs["github"]');
    });
    expect(logger.error).not.toHaveBeenCalled();

    httpServer.emit("close");
    expect(watcher.listenerCount("add")).toBe(0);
    expect(watcher.listenerCount("unlink")).toBe(0);
  });

  it.each(["ts", "tsx", "jsx"])("writes registry types and refreshes on %s hot update", async (extension) => {
    const root = await createTempProject();
    const plugin = hubConnections();
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root });
    const added = await writeConnection(root, `server/connections/slack.${extension}`);
    const invalidateModule = vi.fn();
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: added,
      server: { config: { root }, moduleGraph: { getModuleById: () => ({}), invalidateModule } },
    });
    expect(invalidateModule).toHaveBeenCalled();
    await expect(
      readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8"),
    ).resolves.toContain(`"slack": typeof import(${JSON.stringify(added)})`);
    expect(plugin.api.getDefinitions().map((definition) => definition.name)).toEqual(["slack"]);
  });

  it("writes the same connections.d.ts for an app with Connections", async () => {
    const root = await createTempProject();
    const google = await writeConnection(root, "server/connections/google.ts");
    const slack = await writeConnection(root, "src/slack.connection.ts");
    const mail = await writeConnection(root, "server/connections/team/mail.ts");
    await hubConnections().api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toBe([
      "// Generated by @vite-hub/connections. Do not edit.",
      "declare global {",
      "  interface ViteHubConnectionDefinitionModules {",
      `    "google": typeof import(${JSON.stringify(google)})`,
      `    "slack": typeof import(${JSON.stringify(slack)})`,
      `    "team/mail": typeof import(${JSON.stringify(mail)})`,
      "  }",
      "}",
      "",
      "export {}",
      "",
    ].join("\n"));
  });

  it("writes an empty declaration for an app with Connections and no definitions", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toBe(
      "// Generated by @vite-hub/connections. Do not edit.\ndeclare global {\n  interface ViteHubConnectionDefinitionModules {\n  }\n}\n\nexport {}\n",
    );
  });

  it("converges when two dev servers write the same root at the same time", async () => {
    const root = await createTempProject();
    await writeConnection(root, "server/connections/google.ts");
    await hubConnections().api.prepareTypes({ projectRoot: root });
    const expected = await readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8");
    await rm(join(root, ".vitehub/types/connections.d.ts"));
    await Promise.all(Array.from({ length: 8 }, () => hubConnections().api.prepareTypes({ projectRoot: root })));
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toBe(expected);
  });

  it.each(["api", "config", "configResolved"] as const)("removes the generated declaration when Connections are off, through %s", async (hook) => {
    const root = await createTempProject();
    await writeConnection(root, "server/connections/google.ts");
    await hubConnections().api.prepareTypes({ projectRoot: root });
    const file = join(root, ".vitehub/types/connections.d.ts");
    await expect(readFile(file, "utf8")).resolves.toContain('"google": typeof import(');
    const cleanup = hubConnectionsTypesCleanup();
    if (hook === "api") await cleanup.api!.prepareTypes({ projectRoot: root });
    else await (cleanup[hook] as (config: { root: string }) => Promise<void>)({ root });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no declaration for an app that never had Connections", async () => {
    const root = await createTempProject();
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a declaration symlink at the project root when Connections are off", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    const file = join(root, ".vitehub/types/connections.d.ts");
    const target = join(root, "user.d.ts");
    const content = await readFile(file, "utf8");
    await writeFile(target, content);
    await rm(file);
    await symlink(target, file);
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe(content);
  });

  it("preserves another project's generated declarations and edited custom declarations", async () => {
    const root = await createTempProject();
    const other = await createTempProject();
    const customRoot = join(root, "packages/api");
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });
    await hubConnections().api.prepareTypes({ projectRoot: other });
    const file = join(customRoot, ".vitehub/types/connections.d.ts");
    await writeFile(file, "// user declaration\nexport {}\n");
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(file, "utf8")).resolves.toContain("user declaration");
    await expect(readFile(join(other, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(join(root, ".vitehub/connections-types.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves user declarations at the default root across repeated cleanup hooks", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    const file = join(root, ".vitehub/types/connections.d.ts");
    await writeFile(file, "// user declaration\nexport {}\n");
    const cleanup = hubConnectionsTypesCleanup();
    await cleanup.api!.prepareTypes({ projectRoot: root });
    await cleanup.api!.prepareTypes({ projectRoot: root });
    await expect(readFile(file, "utf8")).resolves.toContain("user declaration");
  });

  it("cleans declarations from the project root when Vite runs from app/", async () => {
    const root = await createTempProject();
    const appRoot = join(root, "app");
    await mkdir(appRoot);
    const plugin = hubConnections();
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root: appRoot });
    const file = join(root, ".vitehub/types/connections.d.ts");
    await expect(readFile(file, "utf8")).resolves.toContain("Generated by @vite-hub/connections");

    await (hubConnectionsTypesCleanup().configResolved as (config: { root: string }) => Promise<void>)({ root: appRoot });

    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires the default declaration when moving to a custom root", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "packages/api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("keeps declarations for another project during cleanup", async () => {
    const firstRoot = await createTempProject();
    const secondRoot = await createTempProject();
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: secondRoot });

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstRoot });

    await expect(readFile(join(secondRoot, "packages/api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("writes both custom roots when preparation runs concurrently", async () => {
    const root = await createTempProject();
    await Promise.all([
      hubConnections({ projectRoot: "packages/one" }).api.prepareTypes({ projectRoot: root }),
      hubConnections({ projectRoot: "packages/two" }).api.prepareTypes({ projectRoot: root }),
    ]);
    await expect(readFile(join(root, "packages/one/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(join(root, "packages/two/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("keeps a custom root's declaration when one app turns Connections off, because another app can share that root", async () => {
    const firstApp = await createTempProject();
    const secondApp = await createTempProject();
    const shared = await createTempProject();
    await writeConnection(shared, "server/connections/google.ts");
    await hubConnections({ projectRoot: shared }).api.prepareTypes({ projectRoot: firstApp });
    await hubConnections({ projectRoot: shared }).api.prepareTypes({ projectRoot: secondApp });

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstApp });

    await expect(readFile(join(shared, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toContain('"google": typeof import(');
  });

  it("publishes a complete declaration when concurrent preparations see different Connections", async () => {
    const root = await createTempProject();
    const file = join(root, ".vitehub/types/connections.d.ts");
    for (let attempt = 0; attempt < 10; attempt++) {
      await rm(join(root, "server"), { recursive: true, force: true });
      await rm(file, { force: true });
      await writeConnection(root, "server/connections/google.ts");
      const extras = Array.from({ length: 200 }, (_, index) => join(root, `server/connections/extra-with-a-long-name-${index}.ts`));
      for (const extra of extras) writeFileSync(extra, "export default {}\n");
      // Each preparation discovers synchronously before it writes, so the first sees 201 Connections and the second one.
      const first = hubConnections().api.prepareTypes({ projectRoot: root });
      for (const extra of extras) rmSync(extra);
      await Promise.all([first, hubConnections().api.prepareTypes({ projectRoot: root })]);
      expect(await readFile(file, "utf8")).toMatch(/^\/\/ Generated by @vite-hub\/connections\. Do not edit\.\ndeclare global \{\n  interface ViteHubConnectionDefinitionModules \{\n(?: {4}"[^\n]+": typeof import\("[^\n]+"\)\n)*  \}\n\}\n\nexport \{\}\n$/);
    }
  });

  it.each(["on", "off"] as const)("removes the ownership manifests of older versions when Connections are %s", async (state) => {
    const root = await createTempProject();
    const manifests = ["connections-types.json", "connections-types-owners.json", "connections-types-owners-recovery.json"].map(name => join(root, ".vitehub", name));
    await mkdir(join(root, ".vitehub"), { recursive: true });
    await Promise.all(manifests.map(manifest => writeFile(manifest, "[]")));
    if (state === "on") await hubConnections().api.prepareTypes({ projectRoot: root });
    else await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    for (const manifest of manifests) await expect(readFile(manifest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

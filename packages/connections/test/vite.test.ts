import { fork } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite";
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
      handlers: Array<{ handler: string; route: string }>;
    };
    const registry = await readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8");
    expect(registry).toContain(JSON.stringify(definition));
    expect(registry).toContain(
      'export const database = () => import("vite-hub/database/drizzle").then(module => module.db)',
    );
    expect(nitro.handlers.map((handler) => handler.route)).toEqual([
      "/_vitehub/connections",
      "/_vitehub/connections/**",
    ]);
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain(
      `from "${importBase}/server"`,
    );
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
      "/portal/_vitehub/connections/**",
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
      "/portal/_vitehub/connections/**",
    ]);
    expect(initializedNitro.options.handlers).toEqual(nitro.handlers);
    expect(initializedNitro.routing.sync).toHaveBeenCalledOnce();
    const handler = await readFile(nitro.handlers[1]!.handler, "utf8");
    expect(handler).toContain('basePath: "/portal/_vitehub/connections"');
    expect(handler).not.toContain("/early/");
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
    ).rejects.toThrow("requires management");
    const managed = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (
      hubConnections({ management: { actor: "./server/connections-auth.ts" } })
        .config as unknown as ConfigHook
    )(managed, { command: "build", mode: "production" });
    const handlers = (managed.nitro as { handlers: Array<{ handler: string }> }).handlers;
    expect(handlers).toHaveLength(2);
    const handler = await readFile(handlers[0]!.handler, "utf8");
    expect(handler).toContain(
      `import actor from ${JSON.stringify(join(root, "server/connections-auth.ts"))}`,
    );
    expect(handler).toContain('createConnectionsHandler({ actor, basePath: "/_vitehub/connections" })');
    expect(handler).toContain("handle(request, event)");
    expect(handler).not.toContain("user:local");
  });

  it("preserves H3 request bodies, external origins, and the original event", async () => {
    const root = await createTempProject();
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(config, { command: "serve", mode: "development" });
    const handlers = (config.nitro as { handlers: Array<{ handler: string }> }).handlers;
    const source = await readFile(handlers[0]!.handler, "utf8");
    expect(source).not.toContain('from "node:stream"');
    // Execute the generated adapter with a recording handler at its Web Request boundary.
    const handle = vi.fn((request: Request, event: unknown) => ({ request, event }));
    const code = source.replace(/^import .*\n/gm, "").replace(/^const handle = .*\n/m, "").replace("export default", "const generated =");
    const adapt = new Function("Readable", "handle", `return (function() { ${stripTypeScriptTypes(code)} return generated })()`)(Readable, handle) as (event: unknown) => { request: Request, event: unknown };
    const body = JSON.stringify({ action: "list" });
    const raw = Object.assign(Readable.from([Buffer.from(body.slice(0, 8)), Buffer.from(body.slice(8))]), {
      headers: { host: "internal:3000", "x-forwarded-host": "public.example:8443, proxy", "x-forwarded-proto": "https, http", "content-type": "application/json" },
      method: "POST", url: "/_vitehub/connections?test=1", socket: {},
    });
    const event = { node: { req: raw } };
    const result = adapt(event);
    expect(result.event).toBe(event);
    expect(result.request.url).toBe("https://public.example:8443/_vitehub/connections?test=1");
    expect(result.request.headers.get("content-type")).toBe("application/json");
    expect(await result.request.text()).toBe(body);

    for (const method of ["GET", "HEAD"]) {
      const request = adapt({ node: { req: { headers: { host: "secure.example" }, method, url: "/callback", socket: { encrypted: true } } } }).request;
      expect(request.url).toBe("https://secure.example/callback");
      expect(request.body).toBeNull();
    }
    const web = new Request("https://public.example/_vitehub/connections", { method: "POST", body });
    const webEvent = { req: web };
    expect(adapt(webEvent)).toEqual({ request: web, event: webEvent });
    expect(handle).toHaveBeenLastCalledWith(web, webEvent);
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
      "/_vitehub/connections/**",
    ]);
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

  it.each([
    ["absolute", 0], ["absolute", 1], ["relative", 0], ["relative", 1],
  ] as const)("preserves a shared %s target when default root %s disables first", async (form, disabled) => {
    const root = await createTempProject();
    const defaults = [join(root, "apps/a"), join(root, "apps/b")];
    await Promise.all(defaults.map(async origin => {
      await mkdir(origin, { recursive: true });
      await writeFile(join(origin, "package.json"), "{}\n");
    }));
    const target = join(root, "shared");
    await writeConnection(target, "server/connections/google.ts");
    const projectRoot = form === "absolute" ? target : "../../shared";
    await Promise.all(defaults.map(origin => hubConnections({ projectRoot }).api.prepareTypes({ projectRoot: origin })));
    const file = join(target, ".vitehub/types/connections.d.ts");
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: defaults[disabled]! });
    await expect(readFile(file, "utf8")).resolves.toContain('"google": typeof import(');
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: defaults[1 - disabled]! });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a shared target when one default moves and cleans the latest generated hash", async () => {
    const first = await createTempProject();
    const second = await createTempProject();
    const target = await createTempProject();
    const moved = await createTempProject();
    await writeConnection(target, "one/connections/google.ts");
    await writeConnection(target, "two/connections/slack.ts");
    await hubConnections({ projectRoot: target }).api.prepareTypes({ projectRoot: first, serverDirs: [join(target, "one")] });
    await hubConnections({ projectRoot: target }).api.prepareTypes({ projectRoot: second, serverDirs: [join(target, "two")] });
    const file = join(target, ".vitehub/types/connections.d.ts");
    await expect(readFile(file, "utf8")).resolves.toContain('"slack": typeof import(');
    await hubConnections({ projectRoot: moved }).api.prepareTypes({ projectRoot: second });
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: second });
    await expect(readFile(file, "utf8")).resolves.toContain('"slack": typeof import(');
    await expect(readFile(join(moved, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: first });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, 1])("coordinates a shared target across distinct default roots in real processes, disabling %s first", async disabled => {
    const defaults = [await createTempProject(), await createTempProject()];
    const target = await createTempProject();
    await writeConnection(target, "server/connections/google.ts");
    const script = join(target, "prepare-shared.mjs");
    await writeFile(script, `
      import { hubConnections, hubConnectionsTypesCleanup } from ${JSON.stringify(new URL("../dist/vite.js", import.meta.url).href)};
      process.on("message", async message => {
        if (message === "exit") process.exit(0);
        if (message === "prepare") await hubConnections({ projectRoot: ${JSON.stringify(target)} }).api.prepareTypes({ projectRoot: process.argv[2] });
        else if (message === "disable") await hubConnectionsTypesCleanup().api.prepareTypes({ projectRoot: process.argv[2] });
        else return;
        process.send(message);
      });
    `);
    const children = defaults.map(origin => fork(script, [origin], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    const request = (child: ReturnType<typeof fork>, message: string) => new Promise<void>((resolve, reject) => {
      const cleanup = () => { child.off("message", receive); child.off("error", failure); child.off("exit", exited); };
      const failure = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number | null) => failure(new Error(`Shared root writer exited early: ${code}`));
      const receive = (response: unknown) => { if (response === message) { cleanup(); resolve(); } };
      child.on("message", receive); child.once("error", failure); child.once("exit", exited);
      child.send(message, error => { if (error) failure(error); });
    });
    try {
      await Promise.all(children.map(child => request(child, "prepare")));
      const file = join(target, ".vitehub/types/connections.d.ts");
      await request(children[disabled]!, "disable");
      await expect(readFile(file, "utf8")).resolves.toContain('"google": typeof import(');
      await request(children[1 - disabled]!, "disable");
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => {
        child.once("exit", () => resolve());
        child.kill();
      })));
    }
  });

  it("preserves another app's default-root declaration during custom generation and repeated cleanup", async () => {
    const first = await createTempProject();
    const second = await createTempProject();
    await hubConnections({ projectRoot: second }).api.prepareTypes({ projectRoot: first });
    await hubConnections({ projectRoot: first }).api.prepareTypes({ projectRoot: second });
    const firstFile = join(first, ".vitehub/types/connections.d.ts");
    const secondFile = join(second, ".vitehub/types/connections.d.ts");
    await expect(readFile(firstFile)).resolves.toBeTruthy();
    await expect(readFile(secondFile)).resolves.toBeTruthy();
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: first });
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: first });
    await expect(readFile(firstFile)).resolves.toBeTruthy();
    await expect(readFile(secondFile)).rejects.toMatchObject({ code: "ENOENT" });
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: second });
    await expect(readFile(firstFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "malformed"])("preserves tracked declarations when both shared ownership copies are %s", async form => {
    const root = await createTempProject();
    const target = await createTempProject();
    await hubConnections({ projectRoot: target }).api.prepareTypes({ projectRoot: root });
    const owners = join(target, ".vitehub/connections-types-owners.json");
    const recovery = join(target, ".vitehub/connections-types-owners-recovery.json");
    for (const file of [owners, recovery]) {
      if (form === "missing") await rm(file);
      else await writeFile(file, "{");
    }
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(target, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(join(root, ".vitehub/connections-types.json"))).resolves.toBeTruthy();
  });

  it.each(["different", "shared"])("keeps %s roots prepared by separate live processes for later cleanup", async (form) => {
    const root = await createTempProject();
    const names = form === "shared" ? ["api", "api"] : ["api-a", "api-b"];
    const script = join(root, "prepare.mjs");
    await writeFile(script, `
      import { hubConnections } from ${JSON.stringify(new URL("../dist/vite.js", import.meta.url).href)};
      process.on("message", async message => {
        if (message === "exit") process.exit(0);
        await hubConnections({ projectRoot: message }).api.prepareTypes({ projectRoot: ${JSON.stringify(root)} });
        process.send("ready");
      });
      process.send("started");
    `);
    const children = [fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] }), fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] })];
    const ready = children.map(child => new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Preparation exited early: ${code}`)));
      child.on("message", message => { if (message === "ready") resolve(); });
    }));
    try {
      // Both processes remain alive until both independent preparations have completed.
      children[0]!.send(names[0]);
      children[1]!.send(names[1]);
      await Promise.all(ready);
      for (const name of names) {
        await expect(readFile(join(root, name, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
      }
      await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
      for (const name of names) {
        await expect(readFile(join(root, name, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
      }
      await new Promise<void>(resolve => {
        children[1]!.once("exit", () => resolve());
        children[1]!.send("exit");
      });
      // A finished writer cannot authorize removal while another owner of the same root is live.
      await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
      await expect(readFile(join(root, names[0]!, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
      await new Promise<void>(resolve => {
        children[0]!.once("exit", () => resolve());
        children[0]!.send("exit");
      });
      await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
      for (const name of names) {
        await expect(readFile(join(root, name, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  });

  it("recovers an abandoned manifest lock", async () => {
    const root = await createTempProject();
    const lockDirectory = join(root, ".vitehub/connections-types.json.lock");
    await mkdir(lockDirectory, { recursive: true });
    const abandoned = new Date(Date.now() - 30_000);
    await utimes(lockDirectory, abandoned, abandoned);
    await hubConnections({ projectRoot: "api" }).api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, "api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(lstat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves declaration symlinks even when target contents match the generated hash", async () => {
    const root = await createTempProject();
    await hubConnections({ projectRoot: "api" }).api.prepareTypes({ projectRoot: root });
    const file = join(root, "api/.vitehub/types/connections.d.ts");
    const target = join(root, "user.d.ts");
    const content = await readFile(file, "utf8");
    await writeFile(target, content);
    await rm(file);
    await symlink(target, file);
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe(content);
  });

  it("stores the absolute root when Windows relative paths cross volumes", async () => {
    const root = await createTempProject();
    const custom = join(root, "api");
    vi.resetModules();
    vi.doMock("node:path", async importOriginal => {
      const actual = await importOriginal<typeof import("node:path")>();
      return {
        ...actual,
        relative: (from: string, to: string) => from === root && to === custom ? actual.win32.relative("C:\\app", "D:\\api") : actual.relative(from, to),
        isAbsolute: (path: string) => actual.isAbsolute(path) || actual.win32.isAbsolute(path),
      };
    });
    try {
      const fresh = await import("../src/vite.ts");
      await fresh.hubConnections({ projectRoot: custom }).api.prepareTypes({ projectRoot: root });
      const manifest = JSON.parse(await readFile(join(root, ".vitehub/connections-types.json"), "utf8")) as Array<{ root: string }>;
      expect(manifest[0]!.root).toBe(custom);
      await fresh.hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
      await expect(readFile(join(custom, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  it("cleans persisted custom-root declarations after a fresh module load", async () => {
    const root = await createTempProject();
    const customRoot = join(root, "packages/api");
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });
    vi.resetModules();
    const fresh = await import("../src/vite.ts");
    await fresh.hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(customRoot, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it.each(["relative", "absolute"])("cleans %s custom output through the Vite config hook", async (form) => {
    const root = await createTempProject();
    const custom = join(root, "api");
    const plugin = hubConnections({ projectRoot: form === "absolute" ? custom : "api" });
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root });
    await (hubConnectionsTypesCleanup().config as (config: { root: string }) => Promise<void>)({ root });
    await expect(readFile(join(custom, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves declarations when ownership metadata is malformed", async () => {
    const root = await createTempProject();
    await hubConnections({ projectRoot: "api" }).api.prepareTypes({ projectRoot: root });
    await writeFile(join(root, ".vitehub/connections-types.json"), "{");
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, "api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("recovers type preparation after shared ownership metadata is corrupted", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    await writeFile(join(root, ".vitehub/connections-types-owners.json"), "{");
    await expect(hubConnections().api.prepareTypes({ projectRoot: root })).resolves.toBeUndefined();
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("cleans safely when publication stops after the primary owner manifest", async () => {
    const firstRoot = await createTempProject();
    const secondRoot = await createTempProject();
    const sharedTarget = await createTempProject();
    const options = { projectRoot: sharedTarget };

    await hubConnections(options).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnections(options).api.prepareTypes({ projectRoot: secondRoot });
    // Simulate an interruption after the authoritative rename and before the
    // recovery copy is replaced. Cleanup must use the complete primary list.
    await rm(join(sharedTarget, ".vitehub/connections-types-owners-recovery.json"));

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstRoot });
    await expect(readFile(join(sharedTarget, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: secondRoot });
    await expect(readFile(join(sharedTarget, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an empty recovery manifest as authoritative", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    const recovery = join(root, ".vitehub/connections-types-owners-recovery.json");
    const owners = join(root, ".vitehub/connections-types-owners.json");
    await writeFile(recovery, "[]");

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });

    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(recovery, "utf8")).resolves.toBe("[]");
    await expect(readFile(owners, "utf8")).resolves.toMatch(/session/);
  });

  it.each(["malformed", "missing"])("recovers %s shared metadata and retires output after the final owner", async (state) => {
    const firstRoot = await createTempProject();
    const secondRoot = await createTempProject();
    const sharedTarget = await createTempProject();
    const options = { projectRoot: sharedTarget };

    await hubConnections(options).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnections(options).api.prepareTypes({ projectRoot: secondRoot });
    const ownersFile = join(sharedTarget, ".vitehub/connections-types-owners.json");
    if (state === "malformed") await writeFile(ownersFile, "{");
    else await rm(ownersFile);

    await hubConnections(options).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstRoot });
    await expect(readFile(join(firstRoot, ".vitehub/connections-types.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(readFile(join(sharedTarget, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    // Cleanup must also recover the surviving owner without another preparation.
    if (state === "malformed") await writeFile(ownersFile, "{");
    else await rm(ownersFile);
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: secondRoot });
    for (const file of [
      join(sharedTarget, ".vitehub/types/connections.d.ts"),
      ownersFile,
      join(sharedTarget, ".vitehub/connections-types-owners-recovery.json"),
      join(secondRoot, ".vitehub/connections-types.json"),
    ]) {
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retires the default declaration when moving to a custom root", async () => {
    const root = await createTempProject();
    await hubConnections().api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "packages/api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("retains previous custom output until cleanup when changing the configured root", async () => {
    const root = await createTempProject();
    await hubConnections({ projectRoot: "packages/old" }).api.prepareTypes({ projectRoot: root });
    await hubConnections({ projectRoot: "packages/new" }).api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, "packages/old/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(join(root, "packages/new/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    for (const name of ["old", "new"]) {
      await expect(readFile(join(root, `packages/${name}/.vitehub/types/connections.d.ts`))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("removes declarations from a previously configured custom root when disabled", async () => {
    const root = await createTempProject();
    const projectRoot = join(root, "packages/api");
    const plugin = hubConnections({ projectRoot: "packages/api" });
    await plugin.api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });

    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes declarations from a custom root after the generating process restarts", async () => {
    const root = await createTempProject();
    const projectRoot = join(root, "packages/api");
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });

    vi.resetModules();
    const { hubConnectionsTypesCleanup: freshCleanup } = await import("../src/vite.ts");
    await freshCleanup().api!.prepareTypes({ projectRoot: root });

    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps declarations for another project during cleanup", async () => {
    const firstRoot = await createTempProject();
    const secondRoot = await createTempProject();
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: secondRoot });

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstRoot });

    await expect(readFile(join(secondRoot, "packages/api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("retains both roots when preparation runs concurrently", async () => {
    const root = await createTempProject();
    await Promise.all([
      hubConnections({ projectRoot: "packages/one" }).api.prepareTypes({ projectRoot: root }),
      hubConnections({ projectRoot: "packages/two" }).api.prepareTypes({ projectRoot: root }),
    ]);

    const manifest = JSON.parse(await readFile(join(root, ".vitehub/connections-types.json"), "utf8")) as Array<{ root: string }>;
    expect(manifest.map(entry => entry.root).sort()).toEqual(["packages/one", "packages/two"]);
    await expect(readFile(join(root, "packages/one/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
    await expect(readFile(join(root, "packages/two/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });

  it("recovers an abandoned manifest lock", async () => {
    const root = await createTempProject();
    const lock = join(root, ".vitehub/connections-types.json.lock");
    await mkdir(lock, { recursive: true });
    await utimes(lock, new Date(0), new Date(0));

    await hubConnections().api.prepareTypes({ projectRoot: root });

    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });
});

import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"
import { runViteHubCli } from "@vite-hub/cli"

import { loadViteHubCliConfig } from "../src/internal/cli-config.ts"
import { isAgentCliEnabled } from "../src/internal/runtime-feature-guard.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(config: "nuxt" | "vite") {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cli-config-"))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${config}.config.ts`), "export default {}\n", "utf8")
  return root
}

describe("ViteHub CLI config loading", () => {
  it.each([
    "export default { vitehub: { agent: false } }\n",
    "export default { vitehub: { agent: { cli: false } } }\n",
    "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ agent: false })] }\n",
    "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ agent: { cli: false } })] }\n",
    "import { vitehub as hub } from 'vite-hub'\nexport default { plugins: [hub({ agent: false })] }\n",
    "import { vitehub as hub } from 'vite-hub'\nexport default { plugins: [hub({ agent: { cli: false } })] }\n",
  ])("honors an Agent CLI opt-out without evaluating config", async source => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), source, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(false)
  })

  it("handles nested Agent options and ignores comments or unrelated objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), `
      // agent: false
      const unrelated = { agent: false }
      export default { vitehub: { agent: { providers: { state: { provider: "memory" } }, cli: false } } }
    `, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(false)
  })

  it("does not treat unrelated agent options in a plugin call as ViteHub config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), `
      const plugin = (options: unknown) => options
      export default { plugins: [plugin({ agent: false })] }
    `, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(true)
  })

  it("does not treat an unrelated local vitehub function as the ViteHub plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), `
      const vitehub = (options: unknown) => options
      export default { plugins: [vitehub({ agent: false })] }
    `, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(true)
  })

  it("recognizes a ViteHub import with comments around the module clause", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), `
      import { vitehub } /* gap */ from /* gap */ "vite-hub"
      export default { plugins: [vitehub({ agent: { cli: false } })] }
    `, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(false)
  })

  it("ignores import-like text in comments and strings when finding the ViteHub binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), `
      // import { vitehub } from "vite-hub"
      const text = 'import { vitehub } from "vite-hub"'
      const vitehub = (options: unknown) => options
      export default { plugins: [vitehub({ agent: false })] }
    `, "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(true)
  })

  it("uses the effective Nuxt config owner for the opt-out guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cli-guard-"))
    roots.push(root)
    await writeFile(join(root, "vite.config.ts"), "export default { vitehub: { agent: false } }\n", "utf8")
    await writeFile(join(root, "nuxt.config.ts"), "export default { vitehub: { agent: {} } }\n", "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(true)
    await writeFile(join(root, "nuxt.config.ts"), "export default { vitehub: { agent: { cli: false } } }\n", "utf8")
    await expect(isAgentCliEnabled(root)).resolves.toBe(false)
  })

  it("loads Nuxt Vite options when Nuxt is the project config owner", async () => {
    const root = await createProject("nuxt")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const resolveViteConfig = vi.fn(async config => ({
      plugins: config.plugins || [],
      root: String(config.root),
    }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [{ name: "nuxt-vitehub" }],
      root,
      vitehubConfigResolved: true,
    })
    expect(resolveViteConfig).toHaveBeenCalledWith(expect.objectContaining({
      configFile: false,
      root,
      vitehubCliDiscovery: true,
    }), "serve", "development")
    expect(loadNuxt).toHaveBeenCalledWith({
      cwd: root,
      dev: true,
      overrides: { devtools: { enabled: false }, vitehubCliDiscovery: true },
      ready: true,
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it("resolves Nuxt's configured Vite root for CLI discovery", async () => {
    const root = await createProject("nuxt")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { root: "app", plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const resolveViteConfig = vi.fn(async config => ({
      plugins: config.plugins || [],
      root: String(config.root),
    }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [{ name: "nuxt-vitehub" }],
      root: join(root, "app"),
      vitehubConfigResolved: true,
    })
    expect(resolveViteConfig).toHaveBeenCalledWith(expect.objectContaining({
      configFile: false,
      root: join(root, "app"),
      vitehubCliDiscovery: true,
    }), "serve", "development")
    expect(close).toHaveBeenCalledOnce()
  })

  it("keeps explicit Vite config ownership", async () => {
    const root = await createProject("vite")
    const loadNuxt = vi.fn()
    const resolveViteConfig = vi.fn(async config => ({ plugins: [], root: String(config.root) }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [],
      root,
      vitehubConfigResolved: true,
    })

    expect(loadNuxt).not.toHaveBeenCalled()
    expect(resolveViteConfig).toHaveBeenCalledWith({ root, vitehubCliDiscovery: true }, "serve", "development")
  })

  it("uses Nuxt ownership when a Nuxt app also has a Vite config", async () => {
    const root = await createProject("vite")
    await writeFile(join(root, "nuxt.config.ts"), "export default {}\n", "utf8")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const loadNuxtViteConfig = vi.fn()
    const resolveViteConfig = vi.fn(async config => ({ plugins: [], root: String(config.root) }))

    await runViteHubCli({
      args: ["--help"],
      cwd: root,
      loadConfig: (directory, command) => loadViteHubCliConfig(directory, command, { loadNuxt, resolveViteConfig }),
      loadNuxtViteConfig,
      stdout: { write: () => true },
    })

    expect(loadNuxt).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(loadNuxtViteConfig).not.toHaveBeenCalled()
  })
})

describe("shipped ViteHub CLI production discovery", () => {
  const execFileAsync = promisify(execFile);
  const bin = resolve(import.meta.dirname, "../dist/bin.js");

  it("inspects build-only Vite output through the framework entrypoint", async () => {
    const root = await createProject("vite");
    await writeFile(
      join(root, "vite.config.ts"),
      `
export default ({ command, mode }) => ({
  plugins: command === "build" && mode === "production" ? [{
    apply: "build",
    name: "production-output",
    vitehub: { inspect: { providerOutput: [{ owner: "test", path: ${JSON.stringify(join(root, ".vitehub/production.json"))} }] } },
  }] : [],
})
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [bin, "inspect", "provider-output", "--json"],
      { cwd: root },
    );
    expect(JSON.parse(stdout).providerOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "test", path: ".vitehub/production.json" }),
      ]),
    );
  });

  it("cancels an Agent Invocation through a deployed Console without loading the project config", async () => {
    const root = await createProject("vite");
    await writeFile(join(root, "vite.config.ts"), "throw new Error('project config loaded')\n");
    const calls: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        calls.push({ authorization: request.headers.authorization, body: JSON.parse(body), url: request.url });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, value: { id: "ainv_1", outcome: "requested", status: "running" } }));
      });
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
      const { stdout } = await execFileAsync(
        process.execPath,
        [bin, "agent", "invocations", "cancel", "ainv_1", "--url", `http://127.0.0.1:${address.port}/_vitehub`],
        { cwd: root, env: { ...process.env, VITEHUB_CONSOLE_AUTHORIZATION: "Bearer cli-test" } },
      );
      expect(stdout).toBe("ainv_1 cancel requested\n");
      expect(calls).toEqual([{
        authorization: "Bearer cli-test",
        body: { input: { body: { action: "cancel" }, id: "ainv_1", method: "POST" }, method: "vitehub:console:invocation" },
        url: "/_vitehub/rpc/__call",
      }]);
    }
    finally {
      await new Promise(resolveClose => server.close(resolveClose));
    }
  });

  it("inspects production-only Nuxt output through the framework entrypoint", async () => {
    const root = await createProject("nuxt");
    await mkdir(join(root, "node_modules"));
    await symlink(
      resolve(import.meta.dirname, "../../cli/node_modules/nuxt"),
      join(root, "node_modules/nuxt"),
      "dir",
    );
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(
      join(root, "nuxt.config.ts"),
      `export default { modules: ["./production-module.ts"] }`,
    );
    await writeFile(
      join(root, "production-module.ts"),
      `
export default function (_options, nuxt) {
  if (nuxt.options.vitehubCliDiscovery !== true) throw new Error("Missing CLI discovery marker")
  if (nuxt.options.devtools.enabled) throw new Error("CLI discovery enabled DevTools")
  if (nuxt.options.dev) return
  nuxt.options.vite.plugins ||= []
  nuxt.options.vite.plugins.push({
    apply: "build",
    name: "production-output",
    vitehub: { inspect: { providerOutput: [{ owner: "test", path: ${JSON.stringify(join(root, ".vitehub/nuxt-production.json"))} }] } },
  })
}
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [bin, "inspect", "provider-output", "--json"],
      { cwd: root },
    );
    expect(JSON.parse(stdout).providerOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "test", path: ".vitehub/nuxt-production.json" }),
      ]),
    );
  }, 30_000);
});

// Installs every @vitehub registry item into four new apps with shadcn-vue, builds each app, and renders every
// example item in Chromium. Run `pnpm --filter @vite-hub/ui build:registry` first, then
// `node --test test/registry-install/install.mjs`. It needs network access to the npm registry.
//
// REGISTRY_APPS=vite-vue,nuxt runs only those apps. REGISTRY_INSTALL_DIR=<dir> keeps the apps in that directory.
// REGISTRY_SCREENSHOTS=<dir> saves a screenshot of each app.
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const published = join(root, "docs/public/r");
const { chromium } = createRequire(join(root, "packages/ui/package.json"))("playwright-core");

const shadcn = "shadcn-vue@2.9.0";
const versions = {
  vue: "3.5.46",
  vite: "^8.0.0",
  pluginVue: "^6.0.0",
  tailwind: "^4.1.0",
  typescript: "^6.0.0",
  nuxt: "npm:nuxt-nightly@5.0.0-2611222336-0ed8910",
  nuxtUI: "^4.13.0",
};

const index = JSON.parse(readFileSync(join(published, "registry.json"), "utf8"));
const items = index.items.map((item) => item.name);
const examples = items.filter((name) => name.startsWith("example-"));

/** The Vue files that render every example item, in import order. */
function exampleImports() {
  return examples.map((name, position) => {
    const file = readdirSync(join(root, "packages/ui/registry", name)).find((entry) => entry.endsWith(".vue"));
    return { name: `Example${position}`, path: `@/components/vitehub/${name}/${file}` };
  });
}

/** The app's one page: every example, and the app's own `script` import and `template` markup. */
function page({ script = "", template = "" } = {}) {
  const imports = exampleImports();
  return `<script setup lang="ts">
${[...imports.map(({ name, path }) => `import ${name} from "${path}";`), script].join("\n")}
</script>

<template>
  <main data-test="examples" style="display: grid; gap: 24px; padding: 24px">
${[...imports.map(({ name }) => `    <${name} />`), template].join("\n")}
  </main>
</template>
`;
}

const viteFiles = (extraDependencies = {}) => ({
  "package.json": JSON.stringify({
    name: "registry-install-vite",
    private: true,
    type: "module",
    scripts: { build: "vite build" },
    dependencies: { vue: versions.vue, ...extraDependencies },
    devDependencies: {
      "@tailwindcss/vite": versions.tailwind,
      "@vitejs/plugin-vue": versions.pluginVue,
      tailwindcss: versions.tailwind,
      typescript: versions.typescript,
      vite: versions.vite,
    },
  }, null, 2),
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>registry install</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>
`,
  "vite.config.ts": `import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
`,
  "tsconfig.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] }, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true },
    include: ["src"],
  }, null, 2),
  "src/style.css": `@import "tailwindcss";\n`,
  "src/main.ts": `import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";

createApp(App).mount("#app");
`,
});

const nuxtFiles = (modules = []) => ({
  "package.json": JSON.stringify({
    name: "registry-install-nuxt",
    private: true,
    type: "module",
    scripts: { build: "nuxt build" },
    dependencies: {
      nuxt: versions.nuxt,
      vue: versions.vue,
      ...(modules.includes("@nuxt/ui") ? { "@nuxt/ui": versions.nuxtUI } : { "@tailwindcss/vite": versions.tailwind }),
      tailwindcss: versions.tailwind,
    },
    devDependencies: { typescript: versions.typescript },
  }, null, 2),
  "nuxt.config.ts": modules.includes("@nuxt/ui")
    ? `export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2026-11-01",
});
`
    : `import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  css: ["~/assets/css/main.css"],
  vite: { plugins: [tailwindcss()] },
  compatibilityDate: "2026-11-01",
});
`,
  // shadcn-vue reads the `@` alias from tsconfig.json. A plain path keeps that read independent of `nuxt prepare`.
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./app/*"], "~/*": ["./app/*"] } } }, null, 2),
  "app/assets/css/main.css": modules.includes("@nuxt/ui") ? `@import "tailwindcss";\n@import "@nuxt/ui";\n` : `@import "tailwindcss";\n`,
});

function componentsJson(css, registry) {
  return JSON.stringify({
    $schema: "https://shadcn-vue.com/schema.json",
    style: "new-york",
    typescript: true,
    tailwind: { config: "", css, baseColor: "neutral", cssVariables: true, prefix: "" },
    aliases: { components: "@/components", composables: "@/composables", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib" },
    iconLibrary: "lucide",
    registries: { "@vitehub": registry },
  }, null, 2);
}

/**
 * Each app: its files, how it starts on shadcn-vue, what it renders next to the examples, and how it is served.
 * `reka` says whether Reka UI may be in the app: only the apps that also use stock shadcn-vue or Nuxt UI have it.
 */
const apps = {
  "vite-vue": {
    files: () => ({ ...viteFiles(), "src/App.vue": page() }),
    // The base item is the preset that starts an app on ViteHub UI.
    init: (registry) => [["init", "--preset", registry.replace("{name}", "base"), "--yes", "--force", "--silent"]],
    serve: "static",
    reka: false,
  },
  nuxt: {
    files: (registry) => ({ ...nuxtFiles(), "components.json": componentsJson("app/assets/css/main.css", registry), "app/app.vue": page() }),
    init: () => [],
    serve: "nitro",
    reka: false,
  },
  "shadcn-reka": {
    files: () => ({
      ...viteFiles(),
      "src/App.vue": page({ script: 'import { Button } from "@/components/ui/button";', template: '    <Button data-test="stock">Stock shadcn-vue</Button>' }),
    }),
    // Stock shadcn-vue with Reka UI, and its own Button, before the @vitehub items.
    init: () => [["init", "--defaults", "--template", "vite", "--base", "reka", "--yes", "--force", "--silent"], ["add", "button", "--yes", "--silent"]],
    serve: "static",
    reka: true,
  },
  "nuxt-ui": {
    files: (registry) => ({
      ...nuxtFiles(["@nuxt/ui"]),
      "components.json": componentsJson("app/assets/css/main.css", registry),
      "app/app.vue": page({ template: '    <UApp><UButton data-test="stock" icon="i-lucide-rocket">Nuxt UI</UButton></UApp>' }),
    }),
    init: () => [],
    serve: "nitro",
    reka: true,
  },
};

const selected = process.env.REGISTRY_APPS ? process.env.REGISTRY_APPS.split(",") : Object.keys(apps);
const screenshots = process.env.REGISTRY_SCREENSHOTS ? resolve(process.env.REGISTRY_SCREENSHOTS) : undefined;

async function exec(command, args, cwd, env = {}) {
  try {
    return await run(command, args, { cwd, env: { ...process.env, CI: "1", NUXT_TELEMETRY_DISABLED: "1", ...env }, maxBuffer: 64 * 1024 * 1024 });
  }
  catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  }
}

/** Serves `docs/public/r` with every vitehub.dev registry URL rewritten to this server, so no item reaches the live site. */
function serveRegistry() {
  return new Promise((done) => {
    const server = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/r\//, ""));
      const file = join(published, name);
      if (!file.startsWith(published) || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      const { port } = server.address();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(readFileSync(file, "utf8").replaceAll("https://vitehub.dev/r/", `http://127.0.0.1:${port}/r/`));
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

function serveStatic(directory) {
  return new Promise((done) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      let file = join(directory, path);
      if (!file.startsWith(directory) || !existsSync(file) || statSync(file).isDirectory()) file = join(directory, "index.html");
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}/`, stop: () => server.close() }));
  });
}

async function serveNitro(directory) {
  const { createServer: probe } = await import("node:net");
  const port = await new Promise((done) => {
    const server = probe().listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => done(free));
    });
  });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [join(directory, ".output/server/index.mjs")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NITRO_PORT: String(port), NITRO_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`The Nuxt server stopped:\n${output}`);
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    }
    catch {}
    await new Promise((wait) => setTimeout(wait, 200));
  }
  child.kill();
  throw new Error(`The Nuxt server did not answer on ${url}:\n${output}`);
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("@vitehub registry install", { concurrency: false }, () => {
  let registry;
  let base;
  let browser;
  const keep = Boolean(process.env.REGISTRY_INSTALL_DIR);

  before(async () => {
    registry = await serveRegistry();
    base = process.env.REGISTRY_INSTALL_DIR ? resolve(process.env.REGISTRY_INSTALL_DIR) : await mkdtemp(join(tmpdir(), "vitehub-registry-install-"));
    await mkdir(base, { recursive: true });
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    registry?.close();
    if (!keep && base) await rm(base, { force: true, recursive: true });
  });

  for (const name of selected) {
    const app = apps[name];
    if (!app) throw new Error(`REGISTRY_APPS names an unknown app: ${name}`);

    it(`${name}: installs every item, builds, and renders every example`, { timeout: 15 * 60_000 }, async () => {
      const url = `http://127.0.0.1:${registry.address().port}/r/{name}.json`;
      const cwd = join(base, name);
      await rm(cwd, { force: true, recursive: true });
      for (const [path, content] of Object.entries(app.files(url))) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), content);
      }
      await exec("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], cwd);
      for (const args of app.init(url)) await exec("npx", ["--yes", shadcn, ...args], cwd);
      {
        // shadcn-vue init writes its own registries. Point @vitehub at this server.
        const config = JSON.parse(await readFile(join(cwd, "components.json"), "utf8"));
        config.registries = { ...config.registries, "@vitehub": url };
        await writeFile(join(cwd, "components.json"), JSON.stringify(config, null, 2));
      }
      await exec("npx", ["--yes", shadcn, "add", ...items.map((item) => `@vitehub/${item}`), "--yes", "--overwrite", "--silent"], cwd);

      const installed = join(cwd, existsSync(join(cwd, "app")) ? "app" : "src", "components/vitehub");
      for (const item of items.filter((entry) => entry !== "base" && entry !== "theme" && entry !== "vitehub-ui-skill")) {
        assert.ok(existsSync(join(installed, item)), `${item} is in ${relative(cwd, installed)}`);
      }
      assert.ok(existsSync(join(cwd, ".agents/skills/vitehub-ui/SKILL.md")), "the skill is installed");
      if (!app.reka) {
        for (const file of filesUnder(installed)) assert.doesNotMatch(await readFile(file, "utf8"), /reka-ui/, relative(cwd, file));
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        assert.equal({ ...manifest.dependencies, ...manifest.devDependencies }["reka-ui"], undefined, "package.json has no reka-ui");
      }

      await exec("npm", ["run", "build"], cwd);
      const server = app.serve === "static" ? await serveStatic(join(cwd, "dist")) : await serveNitro(cwd);
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
        const page = await context.newPage();
        const errors = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(server.url, { waitUntil: "networkidle" });
        await page.locator("[data-test=examples]").waitFor();

        for (const example of examples) {
          const roots = await page.locator(`[data-slot="${example}"] > *`).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-slot")));
          assert.ok(roots.length > 0, `${example} renders`);
          assert.deepEqual(roots.filter((slot) => !slot), [], `every root in ${example} has a data-slot: ${roots.join(", ")}`);
        }
        assert.equal(await page.locator("[data-slot=status]").count(), 6);
        assert.equal(await page.locator("[data-slot=copy-button]").count(), 3);
        // The item stylesheets loaded: the dot has a size, and the button is a flex box (`inline-flex`, which a flex
        // parent turns into `flex`) and not the `inline-block` of Tailwind's preflight.
        assert.ok((await page.locator("[data-slot=status-indicator]").first().boundingBox())?.width > 0, "the status dot has a size");
        assert.match(await page.locator("[data-slot=copy-button]").first().evaluate((element) => getComputedStyle(element).display), /^(?:inline-)?flex$/);
        // The item stylesheets also win over Tailwind's base layer, which sets the padding of a button to 0 and its
        // background to transparent.
        const solid = await page.locator("[data-slot=copy-button][data-variant=solid]").evaluate((element) => {
          const style = getComputedStyle(element);
          return { padding: style.paddingLeft, background: style.backgroundColor };
        });
        assert.notEqual(solid.padding, "0px", "the solid copy button has its padding");
        assert.notEqual(solid.background, "rgba(0, 0, 0, 0)", "the solid copy button has its background");

        const button = page.locator("[data-slot=copy-button]").first();
        await button.click();
        await page.locator("[data-slot=copy-button][data-copied]").first().waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "pnpm add @vite-hub/ui");

        if (screenshots) {
          await mkdir(screenshots, { recursive: true });
          await page.mouse.move(0, 0);
          await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
        }
        assert.deepEqual(errors, [], "no console errors");
      }
      finally {
        await context.close();
        server.stop();
      }
    });
  }
});

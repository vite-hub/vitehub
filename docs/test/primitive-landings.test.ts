import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { createError, defineEventHandler } from "h3";
import { describe, expect, it, vi } from "vitest";
import { discoverQueueDefinitions } from "../../packages/queue/src/discovery";
import { QueueLanding } from "../app/data/primitive-landings/queue";
import { BlobLanding } from "../app/data/primitive-landings/blob";
import { DatabasesLanding } from "../app/data/primitive-landings/databases";
import { ContentLanding } from "../app/data/primitive-landings/content";
import { getPrimitiveLanding, primitiveLandings } from "../app/data/primitive-landings";
import { stubLanding } from "../app/data/primitive-landings/stub";

describe("primitive landing routes", () => {
  it("offers only supported Connections hosts in badges and project tabs", () => {
    const landing = getPrimitiveLanding("connections");
    expect(landing?.supported).toEqual(["Vite", "Nitro"]);
    expect(landing?.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro"]);
  });

  it("resolves registered primitives", () => {
    for (const landing of Object.values(primitiveLandings)) {
      expect(getPrimitiveLanding(landing.slug)).toBe(landing);
    }
  });

  it("leaves unknown and inherited object names to the route fallback", () => {
    for (const slug of ["missing-primitive", "constructor", "toString", "__proto__"]) {
      expect(getPrimitiveLanding(slug)).toBeUndefined();
    }
  });
});

describe("Blob landing HTTP examples", () => {
  const variants = BlobLanding.variants.filter((variant) => variant.framework !== "vite");

  for (const variant of variants) {
    const source = variant.files.find((file) => file.path === "server/api/blob.ts")!.content;
    const createHandler = (result: [Error | null, Blob | null | undefined]) => {
      const get = vi.fn().mockResolvedValue(result);
      const handler = new Function(
        "blob",
        "defineEventHandler",
        "createError",
        source.replace(/^import .*$/gm, "").replace("export default", "return"),
      )({ get }, defineEventHandler, createError) as () => Promise<Blob>;
      return { get, handler };
    };

    it(`${variant.label} returns the stored file body`, async () => {
      const file = new Blob(["Hello from Blob"], { type: "text/plain" });
      const { get, handler } = createHandler([null, file]);
      expect(await handler()).toBe(file);
      expect(get).toHaveBeenCalledWith("greeting.txt");
    });

    it(`${variant.label} reports missing files as 404`, async () => {
      const { handler } = createHandler([null, null]);
      await expect(handler()).rejects.toMatchObject({ statusCode: 404 });
    });

    it(`${variant.label} propagates storage errors`, async () => {
      const error = new Error("Storage unavailable");
      const { handler } = createHandler([error, undefined]);
      await expect(handler()).rejects.toBe(error);
    });
  }
});

describe("primitive landing placeholders", () => {
  it("marks every stub variant as illustrative and removes invented APIs", () => {
    const landing = stubLanding("example", "Example", "/docs/example");
    expect(landing.description).not.toContain("working project");
    for (const variant of landing.variants) {
      expect(variant.illustrative).toBe(true);
      const source = variant.files.map((file) => file.content).join("\n");
      expect(source).toContain("Illustrative pseudocode");
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite|from ["']vite-hub\//);
    }
  });

  it("keeps every Auth variant executable and host-enabled", () => {
    const auth = primitiveLandings.auth;
    expect(auth.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro", "nuxt"]);

    for (const variant of auth.variants) {
      expect(variant.illustrative).not.toBe(true);
      const definition = variant.files.find((file) => file.path === "server/auth.ts");
      expect(definition?.content).toContain('import { defineAuth } from "vite-hub/auth"');
      expect(definition?.content).toContain("export default defineAuth(");

      const config = variant.files.find((file) =>
        variant.framework === "nuxt" ? file.path === "nuxt.config.ts" : file.path === "vite.config.ts",
      );
      expect(config).toBeDefined();
      if (variant.framework === "nuxt") {
        expect(config?.content).toContain('import viteHubNuxt from "vite-hub/nuxt"');
        expect(config?.content).toMatch(/modules:\s*\[\[viteHubNuxt,\s*\{[^}]*auth:\s*true/);
      } else {
        expect(config?.content).toContain('import { vitehub } from "vite-hub"');
        expect(config?.content).toMatch(/plugins:\s*\[\s*vitehub\(\{[^}]*auth:\s*true/);
        if (variant.framework === "nitro") {
          expect(config?.content).toContain('import { nitro } from "nitro/vite"');
          expect(config?.content).toContain("nitro()");
        }
      }
      const source = variant.files.map((file) => file.content).join("\n");
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite|Illustrative pseudocode/);
    }
  });

  it("displays the placeholder notice above the selected files", async () => {
    const source = await readFile(
      new URL("../app/components/PrimitiveProjectGroup.vue", import.meta.url),
      "utf8",
    );
    expect(source).toContain('v-if="currentVariant?.illustrative"');
    expect(source).toContain("Illustrative pseudocode. This layout is not an executable starter.");
  });
});

describe("Queue starter projects", () => {
  it.each(QueueLanding.variants)("discovers the documented Queue name for $label", async (variant) => {
    const root = await mkdtemp(join(tmpdir(), "queue-landing-"));
    try {
      for (const file of variant.files) {
        const path = join(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      const definitions = discoverQueueDefinitions({ rootDir: root });
      expect(definitions.map((definition) => definition.name)).toEqual(["welcome-email"]);
      const definition = await readFile(definitions[0]!.handler, "utf8");
      expect(definition).toContain('import { defineQueue } from "vite-hub/queue"');
      expect(variant.files.map((file) => file.content).join("\n")).not.toContain("definePrimitive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Agents landing", () => {
  it("provides real Agent definitions and enables the host integration in every tab", () => {
    const landing = getPrimitiveLanding("agents")!;
    expect(landing.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro", "nuxt"]);
    for (const variant of landing.variants) {
      expect(variant.illustrative).not.toBe(true);
      const agent = variant.files.find((file) => file.path === "server/agents/greeting.ts")!;
      expect(agent.content).toContain('import { defineAgent } from "vite-hub/agent"');
      expect(agent.content).toContain("run({ prompt })");
      const config = variant.files.find((file) => file.path.endsWith(".config.ts"))!;
      expect(config.content).toContain('preset: "node", agent: true');
      expect(variant.files.map((file) => file.content).join("\n")).not.toMatch(/definePrimitive|vite-hub\/agents|vite-hub\/vite/);
      expect(variant.files.some((file) => file.path.includes("agentss"))).toBe(false);
    }
  });
});

describe("Sandbox landing projects", () => {
  it("supplies package handlers, callers, and configured hosts", () => {
    const landing = getPrimitiveLanding("sandbox")!;
    for (const variant of landing.variants) {
      expect(variant.illustrative).toBe(false);
      const files = new Map(variant.files.map(file => [file.path, file.content]));
      const manifest = JSON.parse(files.get("package.json")!);
      for (const dependency of ["vite-hub", "@vite-hub/sandbox", "@vercel/sandbox", ...(variant.framework === "nuxt" ? ["nuxt"] : ["vite", "nitro"])]) {
        expect(manifest.dependencies[dependency]).toBeTruthy();
      }
      const config = files.get(variant.framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts");
      expect(config).toContain('preset: "vercel", sandbox: true');
      expect(files.get("server/sandboxes/release-notes/index.ts")).toContain("export default async function");
      expect(files.get("server/sandboxes/release-notes/index.ts")).not.toContain("defineSandbox");
      expect(files.get("server/release-notes.ts")).toContain('runSandbox("release-notes", { notes: "ship it" })');
      expect(JSON.parse(files.get("server/sandboxes/release-notes/package.json")!).type).toBe("module");
    }
  });
});

describe("Browser landing examples", () => {
  it("configures supported hosts and uses the discovered Browser API", () => {
    const browser = getPrimitiveLanding("browser")!;
    expect(browser.docsTo).toBe("/docs/browser");
    expect(browser.supported).toContain("Cloudflare Browser Run");
    expect(browser.variants.map(variant => variant.framework)).toEqual(["vite", "nuxt"]);
    for (const variant of browser.variants) {
      expect(variant.illustrative).not.toBe(true);
      const source = variant.files.map(file => file.content).join("\n");
      expect(source).toContain('preset: "cloudflare", browser: true');
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite/);
      expect(variant.files.find(file => file.path === "server/browsers/page-html.ts")?.content).toContain("defineBrowser");
      expect(source).toContain('runBrowser("page-html",');
    }
  });
});

describe("Content landing examples", () => {
  it("provides a discoverable Content definition and a document for every host", () => {
    expect(ContentLanding.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro", "nuxt"]);
    for (const variant of ContentLanding.variants) {
      const definition = variant.files.find((file) => file.path === "server/content.ts");
      expect(definition?.content).toContain('import { defineContent } from "vite-hub/content"');
      expect(definition?.content).toContain("export const content = defineContent(");
      expect(definition?.content).toContain('glob({ cwd: "docs", include: "**/*.md" })');
      expect(variant.files.some((file) => file.path === "docs/guide.md")).toBe(true);
      const manifest = JSON.parse(variant.files.find((file) => file.path === "package.json")!.content);
      expect(manifest.dependencies["vite-hub"]).toBeTruthy();
      expect(manifest.dependencies["comark-content"]).toBeTruthy();
      expect(variant.files.map((file) => file.content).join("\n")).not.toMatch(/definePrimitive|vite-hub\/vite|Illustrative pseudocode/);
    }
  });

  it("mounts the handler explicitly only in the standalone Nitro example", () => {
    for (const variant of ContentLanding.variants) {
      const route = variant.files.find((file) => file.path.startsWith("server/routes/"));
      if (variant.framework === "nitro") {
        expect(route?.path).toBe("server/routes/api/content/[...path].ts");
        expect(route?.content).toContain('import { content } from "../../../content"');
        expect(route?.content).toContain("export default defineContentHandler(content)");
      } else {
        expect(route).toBeUndefined();
        expect(variant.files.find((file) => file.path.endsWith(".config.ts"))?.content).toContain('preset: "node"');
      }
    }
  });
});

describe("database landing examples", () => {
  it.each(DatabasesLanding.variants)("loads the $label schema using the database package", async (variant) => {
    const root = await mkdtemp(new URL("../.database-landing-", import.meta.url));
    try {
      const definition = variant.files.find((file) => /(?:src\/database|server\/databases\/config)\.ts$/.test(file.path));
      expect(definition).toBeDefined();
      const path = join(root, "database.mjs");
      await writeFile(path, definition!.content);
      const { default: database } = await import(/* @vite-ignore */ pathToFileURL(path).href);
      expect(database.name).toBe("default");
      const columns = getTableColumns(database.schema.notes);
      expect(Object.keys(columns)).toEqual(["id", "title"]);
      expect(columns.id.primary).toBe(true);
      expect(columns.title.notNull).toBe(true);
      const config = variant.files.find((file) => file.path.endsWith(".config.ts"));
      expect(config?.content).toContain("database: true");
      expect(variant.files.map((file) => file.content).join("\n")).not.toMatch(/definePrimitive|vite-hub\/databases/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links to the current database guide", async () => {
    expect(DatabasesLanding.docsTo).toBe("/docs/database");
    await expect(readFile(new URL("../content/docs/database/index.md", import.meta.url), "utf8")).resolves.toContain("title: Database");
  });
});

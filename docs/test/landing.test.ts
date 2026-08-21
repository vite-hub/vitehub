import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installOptions, landingPaths, landingPrimitives } from "../app/components/landing/content";

const landingFiles = [
  "Hero.vue",
  "InstallCommand.vue",
  "AgentDiagram.vue",
  "Paths.vue",
  "Primitives.vue",
  "PrimitiveMotion.vue",
  "content.ts",
];

describe("landing page", () => {
  it("makes Agents the first path without hiding Server Primitives", () => {
    expect(landingPaths).toHaveLength(2);
    expect(landingPaths.map((path) => path.id)).toEqual(["agents", "server-primitives"]);

    for (const path of landingPaths) {
      expect(path.tutorialPath).toMatch(/^\/docs\/getting-started\//);
      expect(path.code).toContain("vite-hub/");
      expect(path.code).not.toContain("@vite-hub/");
      expect(path.description.length).toBeLessThan(120);
      expect(path.action.length).toBeLessThan(24);
    }
  });

  it("offers one-click skill and package commands in the hero", () => {
    expect(installOptions.skill.command).toBe("npx skills add https://vitehub.dev");
    expect(installOptions.packages.map((option) => option.value)).toEqual([
      "pnpm",
      "npm",
      "bun",
      "yarn",
    ]);

    for (const option of installOptions.packages) {
      expect(option.command).toContain("vite-hub");
      expect(option.command).not.toContain("@vite-hub/");
    }

    expect(landingPaths[0].code).toContain("run({ prompt })");
    expect(landingPaths[0].code).not.toMatch(/codexDriver|agent\/capabilities|agent\/channels/);
  });

  it("keeps one focal point while restoring concrete code and motion", async () => {
    const source = (
      await Promise.all(
        landingFiles.map((file) =>
          readFile(new URL(`../app/components/landing/${file}`, import.meta.url), "utf8"),
        ),
      )
    ).join("\n");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(source).toContain("Any agent, anywhere.");
    expect(normalizedSource).toContain(
      "Bring any model or coding provider, compose your own Capabilities around a persistent Workspace",
    );
    for (const term of [
      "driver.model",
      "driver.provider",
      "driver.run",
      "instructions.md",
      "workspace.sources",
      "capabilities[]",
      "runAgent()",
      "invoker",
      "runtime",
    ]) {
      expect(source).toContain(term);
    }
    expect(source).toContain("Build your first Agent");
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toMatch(/<pre|<code/);
    expect(source).not.toMatch(/vitehub-backplane\.webp|server-primitives\.webp|agents\.webp/);
    expect(source).not.toMatch(
      /Pick this path|Verified contract|First success \/|The map \/|Your move \/|DIRECT|COMPOSED/,
    );
    expect(source).not.toMatch(/Math\.random|Date\.now|window\.matchMedia/);
    expect(source).not.toMatch(/Agents for any host|Deploy anywhere|Write it once/);
    expect(source).toContain(":aria-pressed");
    expect(source).not.toMatch(/role="(?:tab|tablist|radio|radiogroup)"/);
  });

  it("ends with the full set of animated primitives", () => {
    expect(landingPrimitives.map((primitive) => primitive.id)).toEqual([
      "workspace",
      "kv",
      "queue",
      "workflow",
      "schedule",
      "sandbox",
      "database",
      "blob",
      "auth",
      "env",
      "source",
      "shell",
    ]);
  });

  it("keeps reduced-motion and hidden install controls static", async () => {
    const primitiveMotion = await readFile(
      new URL("../app/components/landing/PrimitiveMotion.vue", import.meta.url),
      "utf8",
    );
    const reducedMotion = primitiveMotion.slice(
      primitiveMotion.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const installCommand = await readFile(
      new URL("../app/components/landing/InstallCommand.vue", import.meta.url),
      "utf8",
    );

    expect(reducedMotion).toContain("animation: none;");
    expect(reducedMotion).not.toMatch(/animation:[^;]*infinite/);
    expect(installCommand).toContain(
      `:class="activeTab === 'package' ? 'w-[16.5rem]' : 'w-0'"`,
    );
    expect(installCommand).toContain("transition: none;");
  });

  it("wires landing-page metadata through Docus", async () => {
    const source = await readFile(new URL("../app/pages/index.vue", import.meta.url), "utf8");

    expect(source).toContain("useSeo({");
    expect(source).toContain('type: "website"');
    expect(source).toContain('defineOgImage("Landing"');
    expect(source).not.toContain("titleTemplate");
  });
});

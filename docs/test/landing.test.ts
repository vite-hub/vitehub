import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { agentStory, installOptions, landingPrimitives } from "../app/components/landing/content";

const landingFiles = [
  "Hero.vue",
  "InstallCommand.vue",
  "AgentStory.vue",
  "Primitives.vue",
  "Closing.vue",
  "PrimitiveMotion.vue",
  "content.ts",
];

describe("landing page", () => {
  it("tells one Agent story where each step highlights its own field", () => {
    const code = agentStory.code.join("\n");

    expect(agentStory.tutorialPath).toBe("/docs/getting-started/first-agent");
    expect(code).toContain("vite-hub/agent");
    expect(code).not.toContain("@vite-hub/");
    expect(agentStory.steps.map((step) => step.id)).toEqual([
      "channel",
      "driver",
      "workspace",
      "capabilities",
    ]);

    const fields = {
      channel: "channels:",
      driver: "driver:",
      workspace: "workspace:",
      capabilities: "capabilities:",
    } as const;
    for (const step of agentStory.steps) {
      const lines = step.lines.map((line) => agentStory.code[line]);
      expect(lines.every((line) => line !== undefined)).toBe(true);
      expect(lines.some((line) => line?.trimStart().startsWith(fields[step.id]))).toBe(true);
      expect(step.to).toMatch(/^\/docs\//);
      expect(step.description.length).toBeLessThan(80);
    }
  });

  it("offers one-click skill and package commands in the hero", () => {
    expect(installOptions.skill.command).toBe("npx skills add https://vitehub.dev --skill vitehub");
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
    expect(normalizedSource).toContain("deploy the same Agent across supported hosts.");
    expect(source).toContain("Build your first Agent");
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toMatch(/<pre|<code/);
    expect(source).not.toMatch(/vitehub-backplane\.webp|server-primitives\.webp|agents\.webp/);
    expect(source).not.toMatch(
      /Pick this path|Verified contract|First success \/|The map \/|Your move \/|DIRECT|COMPOSED/,
    );
    expect(source).not.toMatch(/Math\.random|Date\.now|window\.matchMedia/);
    expect(source).not.toMatch(/any host|Deploy anywhere|Write it once/i);
    expect(source).toContain(":aria-pressed");
    expect(source).not.toMatch(/role="(?:tab|tablist|radio|radiogroup)"/);
  });

  it("keeps the full set of animated primitives", async () => {
    const primitiveMotion = await readFile(
      new URL("../app/components/landing/PrimitiveMotion.vue", import.meta.url),
      "utf8",
    );

    expect(landingPrimitives.map((primitive) => primitive.id)).toEqual([
      "workspace",
      "sandbox",
      "connections",
      "workflow",
      "kv",
      "database",
      "queue",
      "schedule",
      "blob",
      "auth",
      "browser",
      "shell",
      "source",
      "content",
      "email",
      "env",
      "rate-limit",
      "realtime",
    ]);
    for (const primitive of landingPrimitives) {
      expect(primitiveMotion).toContain(`name === '${primitive.id}'`);
      expect(primitive.to).toMatch(/^\/docs\//);
    }
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
    expect(primitiveMotion).toContain(".primitive-motion:not(.is-playing) .a {\n  animation-play-state: paused;");
    expect(primitiveMotion).toContain("animation-iteration-count: 1;");
    const primitives = await readFile(
      new URL("../app/components/landing/Primitives.vue", import.meta.url),
      "utf8",
    );
    expect(primitives).toContain("Replay scenes");
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
    expect(source).toContain("run it across supported hosts");
    expect(source).not.toMatch(/any host/i);
    expect(source).not.toContain("titleTemplate");
  });
});

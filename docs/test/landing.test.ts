import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentStory,
  installOptions,
  landingPrimitives,
  nuxtHubMigration,
  portabilityExamples,
  sharedApi,
} from "../app/components/landing/content";
import { primitiveLandings } from "../app/data/primitive-landings";

const landingFiles = [
  "Hero.vue",
  "InstallCommand.vue",
  "Primitives.vue",
  "Portability.vue",
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

  it("shows one primitive called from a route and from an Agent Capability", () => {
    const [route, agent] = sharedApi.panes;
    const routeCode = route.code.join("\n");
    const agentCode = agent.code.join("\n");

    expect(routeCode).toContain('import { kv } from "vite-hub/kv"');
    expect(routeCode).toContain("kv.get(");
    expect(agentCode).toContain('import { kv } from "vite-hub/agent/capabilities"');
    expect(agentCode).toContain("capabilities: [kv(");
    expect(`${routeCode}\n${agentCode}`).not.toContain("@vite-hub/");
    expect(sharedApi.primitiveTo).toBe("/docs/kv");
    expect(sharedApi.capabilityTo).toBe("/docs/kv/agent-capability");
  });

  it("links NuxtHub users to a migration guide with real import paths", async () => {
    const guide = await readFile(
      new URL("../content/docs/getting-started/migrate-from-nuxthub.md", import.meta.url),
      "utf8",
    );

    expect(nuxtHubMigration.to).toBe("/docs/getting-started/migrate-from-nuxthub");
    for (const entry of nuxtHubMigration.imports) {
      expect(guide).toContain(entry.from);
      expect(guide).toContain(entry.to);
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

  it("leads with portability and keeps the primitive catalog interactive", async () => {
    const source = (
      await Promise.all(
        landingFiles.map((file) =>
          readFile(new URL(`../app/components/landing/${file}`, import.meta.url), "utf8"),
        ),
      )
    ).join("\n");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(source).toContain("The server layer for Vite apps.");
    expect(normalizedSource).toContain("Write once.<br>Deploy anywhere.");
    expect(normalizedSource).toContain(
      "Your application owns the logic. ViteHub connects it to the host's services.",
    );
    expect(source).toContain('aria-label="ViteHub APIs"');
    expect(source).toContain("MotionConfig");
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toMatch(/<pre|<code/);
    expect(source).not.toMatch(/vitehub-backplane\.webp|server-primitives\.webp|agents\.webp/);
    expect(source).not.toMatch(
      /Pick this path|Verified contract|First success \/|The map \/|Your move \/|DIRECT|COMPOSED/,
    );
    expect(source).not.toMatch(/Math\.random|Date\.now|window\.matchMedia/);
    expect(source).toContain(":aria-pressed");
    expect(source).not.toMatch(/role="(?:tab|tablist|radio|radiogroup)"/);
  });

  it("keeps the full set of animated primitives", async () => {
    const primitiveMotion = await readFile(
      new URL("../app/components/landing/PrimitiveMotion.vue", import.meta.url),
      "utf8",
    );

    expect(landingPrimitives.map((primitive) => primitive.id)).toEqual([
      "kv",
      "blob",
      "database",
      "queue",
      "workflow",
      "schedule",
      "auth",
      "connections",
      "workspace",
      "sandbox",
      "browser",
      "shell",
      "source",
      "content",
      "email",
      "channels",
      "env",
      "rate-limit",
      "realtime",
      "agent",
      "ui",
    ]);
    for (const primitive of landingPrimitives) {
      expect(primitiveMotion).toContain(`name === '${primitive.id}'`);
      expect(primitive.to).toMatch(/^\/docs\//);
    }
    expect(portabilityExamples.map((example) => example.id)).toEqual(["storage", "queue", "schedule"]);
    for (const example of portabilityExamples) {
      expect(example.code.join("\n")).toContain("vite-hub/");
      expect(example.to).toMatch(/^\/docs\//);
    }
  });

  it("keeps the package selector aligned with docs section paths", () => {
    expect(Object.keys(primitiveLandings).sort()).toContain("channels");
    for (const landing of Object.values(primitiveLandings)) {
      expect(landing.docsTo, landing.slug).toMatch(/^\/docs\//);
      expect(landing.docsTo, landing.slug).not.toContain("/docs/server-primitives");
      expect(landing.docsTo, landing.slug).not.toContain("/docs/reference/realtime");
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
    expect(primitiveMotion).toContain("animation-iteration-count: infinite;");
    const primitives = await readFile(
      new URL("../app/components/landing/Primitives.vue", import.meta.url),
      "utf8",
    );
    expect(primitives).not.toContain("Replay scenes");
    expect(primitives).toContain(':play="visible"');
    expect(primitives).toContain("useIntersectionObserver(");
    expect(installCommand).toContain(
      `:class="activeTab === 'package' ? 'w-[16.5rem]' : 'w-0'"`,
    );
    expect(installCommand).toContain("transition: none;");
  });

  it("wires landing-page metadata through Docus", async () => {
    const source = await readFile(new URL("../app/pages/index.vue", import.meta.url), "utf8");

    expect(source).toContain("<LandingHero />");
    expect(source).toContain("<LandingPortability />");
    expect(source.indexOf("<LandingHero />")).toBeLessThan(source.indexOf("<LandingPortability />"));
    expect(source).not.toContain("<LandingAgentStory />");
    expect(source).not.toContain("<LandingSharedApi />");
    expect(source).not.toContain("<LandingNuxtHubMigration />");
    expect(source).toContain("useSeo({");
    expect(source).toContain('type: "website"');
    expect(source).toContain('defineOgImage("Landing"');
    expect(source).toContain("deploy it across supported Vite hosts");
    expect(source).not.toContain("titleTemplate");
  });

});

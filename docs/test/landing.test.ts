import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentStory,
  closingFacts,
  closingHosts,
  installOptions,
  landingPrimitives,
  portabilityExamples,
} from "../app/components/landing/content";
import { primitiveLandings } from "../app/data/primitive-landings";

const landingFiles = [
  "Hero.vue",
  "InstallCommand.vue",
  "Primitives.vue",
  "Portability.vue",
  "AgentStory.vue",
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

  it("reads the store the Agent writes from an ordinary route", () => {
    const agentCode = agentStory.code.join("\n");
    const routeCode = agentStory.route.code.join("\n");

    expect(agentCode).toContain('import { browser, kv } from "vite-hub/agent/capabilities"');
    expect(agentCode).toContain('kv({ mode: "write" })');
    expect(routeCode).toContain('import { kv } from "vite-hub/kv"');
    expect(routeCode).toContain('kv.keys()');
    expect(`${agentCode}\n${routeCode}`).not.toContain("@vite-hub/");
    expect(agentStory.route.to).toBe("/docs/kv/agent-capability");
    // Flue and Eve are open and self-hostable, so the line must not claim openness or naming them.
    expect(agentStory.positioning).not.toMatch(/flue|eve|lock-in|open/i);
  });

  it("closes with one button and short facts that the docs back up", async () => {
    const tutorial = await readFile(
      new URL("../content/docs/getting-started/first-server-primitive.md", import.meta.url),
      "utf8",
    );
    const license = await readFile(new URL("../../LICENSE", import.meta.url), "utf8");
    const closing = await readFile(new URL("../app/components/landing/Closing.vue", import.meta.url), "utf8");

    expect(closingFacts.map((fact) => fact.id)).toEqual(["local", "license", "nuxthub", "hosts"]);
    expect(tutorial).toContain("needs no provider account or credentials");
    expect(license).toContain("Apache License");
    expect(closingHosts.map((host) => host.name)).toEqual(["Cloudflare", "Vercel", "Netlify", "Deno", "Node"]);
    // The button opens the first primitive tutorial. No fact may be a second door to the same page.
    for (const fact of closingFacts) {
      if ("to" in fact) expect(fact.to).not.toBe("/docs/getting-started/first-server-primitive");
    }
    expect(closing.match(/<UButton/g)).toHaveLength(1);
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
      expect(option.command).toContain("nitro");
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
    expect(normalizedSource).toContain("Same code on every host. The host picks the provider.");
    // One radius system: the landing is square like the primitive grid.
    expect(source).not.toMatch(/rounded-(?:full|sm|md|lg)\b|999px/);
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
    expect(portabilityExamples.map((example) => example.id)).toEqual([
      "storage",
      "blob",
      "database",
      "queue",
      "workflow",
      "schedule",
      "sandbox",
    ]);
    for (const example of portabilityExamples) {
      expect(example.code.join("\n")).toContain("vite-hub/");
      expect(example.code.join("\n")).not.toContain("@vite-hub/");
      expect(example.hosts.length).toBeGreaterThanOrEqual(3);
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
    expect(installCommand).toContain(":tabindex=\"activeTab === 'package' ? 0 : -1\"");
    expect(installCommand).toContain("transition: none;");
  });

  it("wires landing-page metadata through Docus", async () => {
    const source = await readFile(new URL("../app/pages/index.vue", import.meta.url), "utf8");

    expect(source).toContain("<LandingHero />");
    expect(source).toContain("<LandingPortability />");
    expect(source.indexOf("<LandingHero />")).toBeLessThan(source.indexOf("<LandingPortability />"));
    expect(source.indexOf("<LandingPortability />")).toBeLessThan(source.indexOf("<LandingAgentStory />"));
    expect(source.indexOf("<LandingAgentStory />")).toBeLessThan(source.indexOf("<LandingClosing />"));
    expect(source).not.toContain("<LandingSharedApi />");
    expect(source).not.toContain("<LandingNuxtHubMigration />");
    expect(source).toContain("useSeo({");
    expect(source).toContain('type: "website"');
    expect(source).toContain('defineOgImage("Landing"');
    expect(source).toContain("deploy it across supported Vite hosts");
    expect(source).not.toContain("titleTemplate");
  });

});

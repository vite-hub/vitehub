import { describe, expect, it } from "vitest";
import {
  agentStory,
  installOptions,
  landingPrimitives,
  portabilityExamples,
} from "../app/components/landing/content";
import { primitiveLandings } from "../app/data/primitive-landings";

describe("landing page", () => {
  it("annotates each Agent field on its own line", () => {
    const code = agentStory.code.join("\n");

    expect(agentStory.tutorialPath).toBe("/docs/getting-started/first-agent");
    expect(code).toContain("vite-hub/agent");
    expect(code).not.toContain("@vite-hub/");
    expect(agentStory.notes.map((note) => note.id)).toEqual([
      "channels",
      "driver",
      "workspace",
      "capabilities",
    ]);

    const files = [
      { code: agentStory.code, notes: agentStory.notes },
      { code: agentStory.route.code, notes: agentStory.route.notes },
    ];
    for (const file of files) {
      for (const note of file.notes) {
        // The note sits on the line that names its field, and that line is one of the lines it lights.
        expect(file.code[note.line]).toContain(note.id);
        expect((note.lines as readonly number[]).includes(note.line)).toBe(true);
        expect(note.lines.every((line) => file.code[line] !== undefined)).toBe(true);
        expect(note.to).toMatch(/^\/docs\//);
        // Notes fit on one row beside the code.
        expect(note.text.length).toBeLessThanOrEqual(56);
      }
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

  it("keeps the full set of animated primitives", () => {
    expect(landingPrimitives.map((primitive) => primitive.id)).toEqual([
      "agent",
      "kv",
      "database",
      "blob",
      "queue",
      "workflow",
      "auth",
      "schedule",
      "workspace",
      "sandbox",
      "env",
      "logs",
      "content",
      "source",
      "connections",
      "gateways",
      "decisions",
      "realtime",
      "browser",
      "shell",
      "channels",
      "email",
      "forms",
      "rate-limit",
      "cms",
      "i18n",
      "comments",
      "ui",
    ]);
    for (const primitive of landingPrimitives) {
      expect(primitive.to).toMatch(/^\/docs\//);
      // The ViteHub set, as in the docs sidebar and the Console.
      expect(primitive.icon).toMatch(/^i-vitehub-/);
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

});

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { primitiveLandings } from "../app/data/primitive-landings";

const docsRoot = resolve(import.meta.dirname, "../content/docs");
const before47 = String.raw`4(?!\.(?:[7-9]|[1-9]\d))\b`;
const unsupported = new RegExp(String.raw`Nuxt\s+${before47}|Nitro\s+2\b|nitropack|nuxt@\^?${before47}|["']nuxt["']:\s*["']\^?${before47}`);

// The chat version must match its build fixture. Check the Cloudflare workaround
// before removing its runtime note.
const deferred: Record<string, RegExp> = {
  "agents/build-a-chat-app.md": /"nuxt": "4\.5\.2"/,
  "frameworks-hosts/cloudflare.md": /Nitro 2 also adds `no_nodejs_compat_v2`/,
};

describe("supported framework guidance", () => {
  it("keeps authored reader pages on the supported framework versions", () => {
    const violations: string[] = [];
    for (const page of readdirSync(docsRoot, { recursive: true })) {
      if (typeof page !== "string" || !page.endsWith(".md")) continue;
      // Generated diagnostic pages quote package errors outside this docs migration.
      if (page.replaceAll("\\", "/").split("/").includes("diagnostics")) continue;
      for (const line of readFileSync(resolve(docsRoot, page), "utf8").split("\n")) {
        if (unsupported.test(line) && !deferred[page.replaceAll("\\", "/")]?.test(line)) {
          violations.push(`${page}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it.each(Object.values(primitiveLandings))("uses supported framework versions in published starters ($slug)", (landing) => {
    for (const variant of landing.variants) {
      const source = variant.files.map(file => file.content).join("\n");
      expect(source, `${landing.slug}/${variant.framework}`).not.toMatch(unsupported);
      if (variant.framework !== "nuxt") continue;
      // Standalone runtime examples do not install a framework.
      const hasNuxtSetup = variant.files.some(file => file.path === "nuxt.config.ts"
        || (file.path === "package.json" && /"nuxt"\s*:/.test(file.content)));
      if (!variant.illustrative && hasNuxtSetup) {
        expect(source, landing.slug).toContain("npm:nuxt-nightly@5x");
      }
    }
  });
});

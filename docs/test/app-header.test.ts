import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import config from "../nuxt.config";

// The header ships with @vite-hub/docs and reads the brand, the badge, and the links from the `docs` options.
const headerUrl = new URL("../../packages/docs/runtime/app/components/AppHeader.vue", import.meta.url);

describe("docs header", () => {
  it("labels the current release state and explains it on hover", async () => {
    const header = await readFile(headerUrl, "utf8");

    expect(config.docs?.site).toMatchObject({
      name: "ViteHub",
      badge: { label: "alpha", tooltip: "Just a library where I test different solutions and agents. APIs break all the time." },
    });
    expect(header).toContain("<UTooltip");
    expect(header).toContain(':text="site.badge?.tooltip ?? undefined"');
    expect(header).toContain(":aria-label=\"site.badge ? `${site.name} ${site.badge.label}` : site.name\"");
    // The brand opens the docs base on docs routes and the home page elsewhere.
    expect(header).toContain(":to=\"isDocsRoute ? base : '/'\"");
    expect(header).toContain('<span v-if="site.badge" class="vh-brand-alpha">{{ site.badge.label }}</span>');
    // The mobile menu focuses the brand link on open; the tooltip must not cover the menu.
    expect(header).toContain("ignore-non-keyboard-focus");
  });

  it("keeps site links and docs navigation in the mobile docs menu", async () => {
    const header = await readFile(headerUrl, "utf8");

    expect(header).toContain('<div v-if="isDocsRoute" class="vh-docs-menu -mx-4 -my-2">');
    expect(header).toContain('v-for="link in docsMobileLinks"');
    expect(header).toContain("mobileLinks.filter(link => link.to !== base && !link.to.startsWith(`${base}/`))");
    expect(header).toContain('v-if="!isDocsRoute"');
    expect(header).toContain("...(start?.links ?? []).filter(link => link.to !== base)");
    expect(config.docs?.start?.links?.map(link => [link.label, link.to])).toEqual([
      ["All docs", "/docs"],
      ["Tutorials", "/tutorials"],
      ["Projects", "/projects"],
      ["Templates", "/templates"],
    ]);
  });
});

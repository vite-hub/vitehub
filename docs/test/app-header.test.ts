import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("docs header", () => {
  it("labels the current release state and explains it on hover", async () => {
    const header = await readFile(
      new URL("../app/components/AppHeader.vue", import.meta.url),
      "utf8",
    );

    expect(header).toContain("<UTooltip");
    expect(header).toContain(
      'text="Just a library where I test different solutions and agents. APIs break all the time."',
    );
    expect(header).toContain('aria-label="ViteHub alpha"');
    expect(header).toContain('<span class="vh-brand-alpha">alpha</span>');
    // The mobile menu focuses the brand link on open; the tooltip must not cover the menu.
    expect(header).toContain("ignore-non-keyboard-focus");
  });

  it("keeps site links and docs navigation in the mobile docs menu", async () => {
    const header = await readFile(
      new URL("../app/components/AppHeader.vue", import.meta.url),
      "utf8",
    );

    expect(header).not.toContain("toggle: isSupportMatrix");
    expect(header).toContain('<div v-if="isDocsRoute" class="-mx-4 -my-2">');
    expect(header).toContain('v-for="link in docsMobileLinks"');
    expect(header).toContain('mobileLinks.filter((link) => !link.to.startsWith("/docs"))');
  });
});

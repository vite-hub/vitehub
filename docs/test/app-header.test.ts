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
  });
});

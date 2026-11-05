import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");

it("gives the thread header and message buttons 44px targets on a touch screen only", () => {
  const coarse = /@media \(pointer: coarse\) \{\s*:is\(\[data-slot="comment-thread-header"\], \[data-slot="comment-reply-actions"\]\) > :is\(button, a\) \{([^}]*)\}/.exec(stylesheet);
  expect(coarse?.[1]).toContain("min-height: 2.75rem;");
  expect(coarse?.[1]).toContain("min-width: 2.75rem;");
  // A mouse keeps the 24px buttons: no rule outside the media query sizes them.
  expect(stylesheet.replace(coarse![0], "")).not.toMatch(/comment-thread-header"\][^{]*>[^{]*button[^{]*\{[^}]*min-height/);
});

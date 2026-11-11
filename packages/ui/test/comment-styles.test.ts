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

it("keeps a long thread in the margin inside the screen, its messages scrolling above the reply box", () => {
  const card = [...stylesheet.matchAll(/\[data-slot="comment-layer-popover"\]\[data-margin="true"\]\[data-margin-key\] \{([^}]*)\}/g)].map(([, body]) => body).join("");
  expect(card).toContain("max-height: calc(100dvh - 2rem);");
  expect(card).toContain("flex-direction: column;");
  const messages = /\[data-slot="comment-layer-popover"\]\[data-margin="true"\] \[data-slot="comment-thread-messages"\] \{([^}]*)\}/.exec(stylesheet);
  expect(messages?.[1]).toContain("min-height: 0;");
  expect(messages?.[1]).toContain("max-height: none;");
});

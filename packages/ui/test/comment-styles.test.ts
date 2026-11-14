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

it("draws a picture in a comment box as Drop does: a 40px square with no name and a round Remove badge on its corner", () => {
  const picture = '[data-slot="comment-composer"] [data-slot="attachment"]:has(> [data-slot="attachment-media"][data-variant="image"])';
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const square = new RegExp(`${escape(picture)} \\{([\\s\\S]*?)\\n  \\}\\n`).exec(stylesheet)?.[1];
  expect(square).toContain("padding: 0;");
  expect(square).toMatch(/> \[data-slot="attachment-media"\] \{[^}]*width: 2\.5rem;/);
  expect(square).toMatch(/> \[data-slot="attachment-media"\] \{[^}]*outline: 1px solid color-mix\(in oklab, var\(--vh-highlighted\) 10%, transparent\);/);
  // The name is hidden on screen only. The image's alt and the button's label still name the file.
  expect(square).toMatch(/> \[data-slot="attachment-content"\] \{[^}]*clip-path: inset\(50%\);/);
  expect(square).toMatch(/> \[data-slot="attachment-actions"\] \{[^}]*right: -0\.375rem;[^}]*top: -0\.375rem;/);
  // The badge is a Nuxt UI button, so its rule is outside the layers to win over Nuxt UI's classes.
  const badge = new RegExp(`\\n${escape(picture)} \\[data-slot="attachment-actions"\\] > button \\{([^}]*)`).exec(stylesheet)?.[1];
  expect(badge).toContain("background: var(--vh-highlighted);");
  expect(badge).toContain("color: var(--vh-inverted);");
  expect(badge).toContain("border-radius: 9999px;");
  expect(badge).toContain("width: 1.25rem;");
  expect(stylesheet.indexOf(`\n${picture} [data-slot="attachment-actions"] > button`)).toBeLessThan(stylesheet.indexOf("@layer components {"));
});

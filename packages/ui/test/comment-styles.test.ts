import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const focusRing = await readFile(new URL("../theme-focus-ring.css", import.meta.url), "utf8");

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

it("centers one line of a small row box on its 28px buttons, and gives a wrapped box the full width", () => {
  const small = /\[data-slot="comment-composer"\]\[data-size="sm"\]\[data-layout="row"\] \{[\s\S]*?& \[data-slot="prompt-input-textarea"\] \{([^}]*)\}/.exec(stylesheet)?.[1];
  // 21px of text and 3.5px above and below make the 28px of a button.
  expect(small).toContain("line-height: 1.3125rem;");
  expect(small).toContain("min-height: 1.75rem;");
  expect(small).toContain("padding: 0.21875rem 0.25rem;");
  const wrapped = /\[data-slot="comment-composer"\]\[data-layout="row"\]\[data-multiline="true"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(wrapped).toMatch(/& \[data-slot="prompt-input-textarea"\] \{[^}]*flex-basis: 100%;[^}]*order: 0;/);
  expect(wrapped).toMatch(/& \[data-slot="prompt-input-spacer"\] \{[^}]*display: block;/);
});

it("draws one frame around the box of a new comment: the bubble's, with a firmer hairline on focus", () => {
  // The field of a box with frame="none" shows no edge on focus, so the bubble is not a box inside a box.
  const none = /\[data-slot="comment-composer"\]\[data-frame="none"\]:not\(\[data-dragging="true"\]\) \[data-slot="prompt-input-group"\]:has\(\[data-slot="prompt-input-textarea"\]:focus-visible\) \{([^}]*)\}/.exec(focusRing);
  expect(none?.[1]).toContain("border-color: transparent;");
  expect(none?.[1]).toContain("box-shadow: none;");
  // It comes after the row box's focus edge, which has the same specificity.
  expect(focusRing.indexOf(none![0])).toBeGreaterThan(focusRing.indexOf('[data-slot="comment-composer"][data-layout="row"] {'));
  expect(focusRing).not.toContain('[data-draft="true"]');
  const focused = /\[data-slot="comment-layer-popover"\]:has\(\[data-slot="comment-composer"\]\[data-frame="none"\] \[data-slot="prompt-input-textarea"\]:focus-visible\) \{([^}]*)\}/.exec(stylesheet);
  expect(focused?.[1]).toContain("--vh-bubble-edge: color-mix(in oklab, var(--vh-highlighted) 22%, transparent);");
  expect(stylesheet).toContain("0 0 0 1px var(--vh-bubble-edge),");
  const small = /> \[data-slot="comment-layer-popover"\]:has\(> \[data-slot="comment-composer"\]\[data-size="sm"\]\) \{([^}]*)\}/.exec(stylesheet);
  expect(small?.[1]).toContain("--vh-bubble-radius: 1.125rem;");
});

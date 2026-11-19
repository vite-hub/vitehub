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

it("stacks the pictures of a comment box, and fans them out as 3.5rem cards with a round Remove badge", () => {
  const card = /\n  \[data-slot="comment-image-stack-card"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(card).toContain("width: 1.75rem;");
  expect(card).toMatch(/\[data-slot="comment-image-stack-remove"\] \{[^}]*visibility: hidden;/);
  const fanned = /\[data-slot="comment-image-stack"\]\[data-fanned="true"\] \[data-slot="comment-image-stack-card"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(fanned).toContain("width: 3.5rem;");
  expect(fanned).toContain("left: calc(var(--vh-stack-index) * var(--vh-stack-step));");
  expect(fanned).toMatch(/\[data-slot="comment-image-stack-remove"\] \{[^}]*visibility: visible;/);
  // The badge is a Nuxt UI button, so its rule is outside the layers to win over Nuxt UI's classes.
  const badge = /\n\[data-slot="comment-image-stack-remove"\] \{([^}]*)/.exec(stylesheet)?.[1];
  expect(badge).toContain("background: var(--vh-highlighted);");
  expect(badge).toContain("color: var(--vh-inverted);");
  expect(badge).toContain("border-radius: 9999px;");
  expect(badge).toContain("width: 1.25rem;");
  expect(stylesheet.indexOf('\n[data-slot="comment-image-stack-remove"] {')).toBeLessThan(stylesheet.indexOf("@layer components {"));
});

it("draws the sm reply box as a soft field with no divider, and its accented edge only while it has the focus", () => {
  const field = /\[data-slot="comment-thread"\]\[data-size="sm"\] > \[data-slot="comment-composer"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(field).toContain("border-block-start: 0;");
  expect(field).toMatch(/\[data-slot="prompt-input-group"\] \{[^}]*background: var\(--vh-bg-elevated\);[^}]*border-color: transparent;/);
  // Focus styles live in theme-focus-ring.css, after the row box's own focus edge, which this rule outranks.
  const focus = '\n[data-slot="comment-thread"][data-size="sm"] > [data-slot="comment-composer"][data-layout="row"]:not([data-dragging="true"]) [data-slot="prompt-input-group"]:has([data-slot="prompt-input-textarea"]:focus-visible) {';
  const at = focusRing.indexOf(focus);
  expect(at).toBeGreaterThan(focusRing.indexOf('[data-slot="comment-composer"][data-layout="row"] {'));
  expect(focusRing.slice(at, focusRing.indexOf("}", at))).toContain("border-color: var(--vh-border-accented);");
  expect(stylesheet).toContain("--vh-border-accented: var(--vh-ui-border-accented, var(--ui-border-accented, ");
});

it("keeps the shape of a comment's only image, up to 10rem tall, and crops the tiles of more", () => {
  const only = /\[data-count="1"\] > \[data-slot="comment-reply-image"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(only).toMatch(/& img \{[^}]*height: auto;[^}]*max-height: 10rem;[^}]*width: auto;/);
  const tile = /\n  \[data-slot="comment-reply-image"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(tile).toMatch(/& img \{[^}]*object-fit: cover;/);
  const mosaic = /\n  \[data-slot="comment-reply-images"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(mosaic).toMatch(/&\[data-count="2"\] \{[^}]*grid-template-columns: 1fr 1fr;/);
  expect(mosaic).toMatch(/&\[data-count="4"\] \{[^}]*grid-template-columns: 1fr 1fr;/);
});

it("opens an sm thread beside its pin in Drop's 340px card, pointing at the pin, with its messages filling the card", () => {
  const card = /\[data-slot="comment-layer-popover"\]:not\(\[data-margin\], \[data-preview\]\):has\(> \[data-slot="comment-thread"\]\[data-size="sm"\]\) \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(card).toContain("--vh-comment-card-width: 21.25rem;");
  expect(card).toMatch(/\[data-slot="comment-thread-messages"\] \{[^}]*max-height: none;[^}]*min-height: 0;/);
  const corners = [...stylesheet.matchAll(/\[data-slot="comment-layer-item"\]([^ ]*) > \[data-slot="comment-layer-popover"\]:not\(\[data-margin\], \[data-floating\], \[data-preview\]\):has\(> \[data-slot="comment-thread"\]\[data-size="sm"\]\) \{\s*border-radius: ([^;]+);/g)]
    .map(([, flip, radius]) => [flip, radius]);
  expect(corners).toEqual([
    ["", "0.375rem var(--vh-comment-card-radius) var(--vh-comment-card-radius)"],
    ['[data-flip-x="true"]', "var(--vh-comment-card-radius) 0.375rem var(--vh-comment-card-radius) var(--vh-comment-card-radius)"],
    ['[data-flip-y="true"]', "var(--vh-comment-card-radius) var(--vh-comment-card-radius) var(--vh-comment-card-radius) 0.375rem"],
    ['[data-flip-x="true"][data-flip-y="true"]', "var(--vh-comment-card-radius) var(--vh-comment-card-radius) 0.375rem"],
  ]);
  // A flipped card measures its own width, so a 340px card stays on a narrow screen.
  expect(stylesheet).toContain("min(var(--vh-comment-card-width), 100vw - 1rem)");
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

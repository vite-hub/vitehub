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

it("draws the sm reply box as a soft field with no divider, and its accented edge only while it has the focus", () => {
  const field = /\[data-slot="comment-thread"\]\[data-size="sm"\] > \[data-slot="comment-composer"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(field).toContain("border-block-start: 0;");
  expect(field).toMatch(/\[data-slot="prompt-input-group"\] \{[^}]*background: var\(--vh-bg-elevated\);[^}]*border-color: transparent;/);
  // theme-focus-ring.css is outside the layers, so the focus rule is too, after the last layer opens.
  const focus = '\n[data-slot="comment-thread"][data-size="sm"] > [data-slot="comment-composer"][data-layout="row"]:not([data-dragging="true"]) [data-slot="prompt-input-group"]:has([data-slot="prompt-input-textarea"]:focus-visible) {';
  const at = stylesheet.indexOf(focus);
  expect(at).toBeGreaterThan(-1);
  expect(stylesheet.slice(at, stylesheet.indexOf("}", at))).toContain("border-color: var(--vh-border-accented);");
  expect(stylesheet).toContain("--vh-border-accented: var(--vh-ui-border-accented, var(--ui-border-accented, ");
});

it("keeps the shape of a comment's image, up to 10rem tall, instead of a 4:3 crop", () => {
  const images = /\[data-slot="comment-reply-images"\] \{([\s\S]*?)\n  \}\n/.exec(stylesheet)?.[1];
  expect(images).toMatch(/& \.vh-image-preview \{[^}]*aspect-ratio: auto;[^}]*max-height: 10rem;[^}]*max-width: 100%;[^}]*width: auto;/);
  expect(images).toMatch(/& \.vh-image-preview img \{[^}]*height: auto;[^}]*max-height: 10rem;[^}]*object-fit: contain;/);
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

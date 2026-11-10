import { describe, expect, it } from "vitest";

import { pruneStylesheet } from "../src/standalone/stylesheet.ts";

const used = new Set(["vh-comment", "comment-thread"]);

describe("pruneStylesheet()", () => {
  it("drops the selectors that need a class or slot that the build does not name", () => {
    expect(pruneStylesheet(".vh-comment{color:red}.vh-chat{color:blue}.vh-comment,.vh-chat__composer{margin:0}", used))
      .toBe(".vh-comment{color:red}.vh-comment{margin:0}");
    expect(pruneStylesheet("[data-slot=\"comment-thread\"] p{gap:0}[data-slot=code-block]{gap:1px}[data-slot='code']{gap:2px}", used))
      .toBe("[data-slot=\"comment-thread\"] p{gap:0}");
  });

  it("keeps selectors whose classes are inside parentheses, and other attribute operators", () => {
    const css = ".vh-comment:not(.vh-chat){a:b}:is(.vh-chat,.vh-comment){c:d}[data-slot^=code]{e:f}[data-slot]{g:h}";
    expect(pruneStylesheet(css, used)).toBe(css);
  });

  it("prunes inside @layer, @media and @supports, and drops the blocks it empties", () => {
    expect(pruneStylesheet("@layer theme,base;@layer components{.vh-chat{a:b}@media (hover:hover){.vh-comment:hover{c:d}.vh-chat:hover{e:f}}}@supports (x:y){.vh-chat{g:h}}", used))
      .toBe("@layer theme,base;@layer components{@media (hover:hover){.vh-comment:hover{c:d}}}");
  });

  it("keeps other at-rules and braces inside strings", () => {
    const css = "@keyframes vh-chat-spin{to{rotate:1turn}}@font-face{font-family:x}.vh-comment:after{content:\"}{\"}";
    expect(pruneStylesheet(`${css}.vh-chat:after{content:"}"}`, used)).toBe(css);
  });
});

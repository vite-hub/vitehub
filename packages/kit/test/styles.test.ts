import { describe, expect, it } from "vitest";

import { inlineWebCss, scopeStyles } from "../scripts/styles.ts";

// The rules of the scoped sheet, without its header and the color-scheme rule at the end.
function scoped(css: string): string {
  const out = scopeStyles(css);
  return out.slice(out.indexOf("*/") + 2, out.lastIndexOf("/* The scope root takes")).trim();
}

describe("scopeStyles", () => {
  it("puts a part and a plain element inside the scope root, with no added specificity", () => {
    expect(scoped('[data-slot="button"] { color: red; }\n:is(a, summary):focus-visible { outline: 0; }')).toBe(
      ':where(.ui-sdk) [data-slot="button"] { color: red; }\n:where(.ui-sdk) :is(a, summary):focus-visible { outline: 0; }',
    );
  });

  it("moves the page root to the scope root", () => {
    expect(scoped(":where(:root, :host) { --a: 1; }")).toBe(":where(.ui-sdk) { --a: 1; }");
    expect(scoped(":root { --a: 1; }")).toBe(".ui-sdk { --a: 1; }");
    expect(scoped(":where(html) { color: red; }")).toBe(":where(.ui-sdk) { color: red; }");
    expect(scoped("body > main { color: red; }")).toBe(":where(.ui-sdk) > main { color: red; }");
  });

  it("matches a theme marker inside the scope, on the scope root, and around it", () => {
    expect(scoped(".dark { --a: 1; }")).toBe(":where(.ui-sdk) .dark,\n.ui-sdk:where(.dark),\n:where(.dark) .ui-sdk { --a: 1; }");
    expect(scoped('[data-theme="dark"] [data-slot="x"] { --a: 1; }')).toBe(
      ':where(.ui-sdk) [data-theme="dark"] [data-slot="x"],\n.ui-sdk:where([data-theme="dark"]) [data-slot="x"],\n:where([data-theme="dark"]) .ui-sdk [data-slot="x"] { --a: 1; }',
    );
    expect(scoped(":root.dark { --a: 1; }")).toBe(".ui-sdk:where(.dark),\n:where(.dark) .ui-sdk { --a: 1; }");
  });

  it("keeps nested rules, at-rules, keyframes, and the indentation", () => {
    const css = `@layer ui-sdk {
  @media (width < 40rem) {
    [data-slot="x"],
    [data-slot="y"] {
      color: red;
      &:hover { color: blue; }
      [data-side="bottom"] > & { color: green; }
    }
  }
  @supports (anchor-name: --a) { a { color: red; } }
  @container (width > 1px) { hr { color: red; } }
}
@keyframes spin { from { rotate: 0deg; } to { rotate: 1turn; } }
@property --ui-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@font-face { font-family: X; src: url(x.woff2); }`;
    expect(scoped(css)).toBe(`@layer ui-sdk {
  @media (width < 40rem) {
    :where(.ui-sdk) [data-slot="x"],
    :where(.ui-sdk) [data-slot="y"] {
      color: red;
      &:hover { color: blue; }
      [data-side="bottom"] > & { color: green; }
    }
  }
  @supports (anchor-name: --a) { :where(.ui-sdk) a { color: red; } }
  @container (width > 1px) { :where(.ui-sdk) hr { color: red; } }
}
@keyframes spin { from { rotate: 0deg; } to { rotate: 1turn; } }
@property --ui-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@font-face { font-family: X; src: url(x.woff2); }`);
  });

  it("gives the scope root the page's color-scheme, after every other rule", () => {
    expect(scopeStyles("a { color: red; }").trimEnd().endsWith(":where(.ui-sdk) {\n  color-scheme: inherit;\n}")).toBe(true);
  });

  it("stops on a selector or an at-rule it cannot scope", () => {
    expect(() => scopeStyles("@scope (.card) { a { color: red; } }")).toThrow("@scope holds rules");
    expect(() => scopeStyles("& a { color: red; }")).toThrow("has no parent to scope");
    expect(() => scopeStyles("main :root { color: red; }")).toThrow("is not the first part");
    expect(() => scopeStyles(".dark.card { color: red; }")).toThrow("shares a compound");
  });
});

describe("inlineWebCss", () => {
  it("replaces the import with web.css", () => {
    expect(inlineWebCss('/* a */\n@import "@ui-sdk/core/web.css";\nb {}', "@layer ui-sdk { a {} }\n")).toBe(
      '/* a */\n/* @ui-sdk/core/web.css (Apache-2.0), with the patch in vite-hub/vitehub patches/. */\n@layer ui-sdk { a {} }\nb {}',
    );
    expect(() => inlineWebCss("b {}", "")).toThrow("has no @import");
  });
});

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markdownAnchors, markdownLinks, validateDocumentationLinks } from "../scripts/markdown-links.mjs";

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vitehub-doc-links-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

describe("documentation link validation", () => {
  it("parses rendered link forms outside code", () => {
    expect(markdownLinks(`
[Inline](./guide.md#install)
[Nested](./api_(stable).md)
[Reference][guide]
[Shortcut]
::card
---
to: /docs/card
---
::
::card
---
to: /docs/card#install
---
::
::card
---
to: #install
---
::
<a href="/docs/html">HTML</a>

[guide]: /docs/guide
[shortcut]: /docs/shortcut

\`[ignored](./missing.md)\`
\`\`\`
[ignored](./missing.md)
\`\`\`
`)).toEqual([
      "/docs/card",
      "/docs/card#install",
      "#install",
      "/docs/html",
      "./guide.md#install",
      "./api_(stable).md",
      "/docs/guide",
      "/docs/shortcut",
    ]);
  });

  it("matches generated anchors for repeated headings", () => {
    expect([...markdownAnchors("# API & runtime\n\n## `Repeat`\n\n## Repeat\n\n## Repeat-1\n\n## Repeat")]).toEqual([
      "api-runtime",
      "repeat",
      "repeat-1",
      "repeat-1-1",
      "repeat-2",
    ]);
    expect([...markdownAnchors("# 123 start\n\n# --trim--\n\n# A---B")]).toEqual([
      "_123-start",
      "trim",
      "a-b",
    ]);
  });

  it("accepts relative routes and anchors across docs and public package READMEs", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Guide](./guide#install)\n[Repeated](./guide#install-1)",
      "docs/content/docs/guide.md": "# Guide\n\n## Install\n\n## Install",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[Source](../../docs/content/docs/guide.md#install)\n[Site](https://vitehub.dev/docs/guide#install)",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [], files: 3 });
  });

  it("accepts root-served public assets", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Logo](/vitehub-logo.svg)",
      "docs/public/vitehub-logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("reports missing routes, files, and anchors", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Route](/docs/missing)\n[Anchor](#missing)",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[File](../missing/README.md)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing" does not exist'),
      expect.stringContaining("anchor #missing does not exist"),
      expect.stringContaining('file "../missing/README.md" does not exist'),
    ]);
  });

  it("reports missing MDC and HTML routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": `# Docs

::card
---
to: /docs/missing-card
---
::

<a href="/docs/missing-html">Missing</a>`,
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-card" does not exist'),
      expect.stringContaining('route "/docs/missing-html" does not exist'),
    ]);
  });

  it("reports missing anchors in unquoted MDC destinations", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": `# Docs

::card
---
to: /docs/guide#missing
---
::

::card
---
to: #also-missing
---
::`,
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #missing does not exist"),
      expect.stringContaining("anchor #also-missing does not exist"),
    ]);
  });
});

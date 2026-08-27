import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  docsManifestRoutes,
  markdownAnchors,
  markdownLinks,
  validateDocumentationLinks,
} from "../scripts/markdown-links.mjs";

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
  it("includes only pages represented by the docs manifest", () => {
    expect(docsManifestRoutes({
      rootPage: { path: "/docs" },
      sections: [
        { path: "/docs/guide", pages: [{ path: "/docs/guide/start" }] },
        { path: "/docs/reference", pages: [{ path: "/docs/reference" }, { path: "/docs/reference/api" }] },
      ],
    })).toEqual(["/docs", "/docs/guide/start", "/docs/reference", "/docs/reference/api"]);
  });

  it("parses rendered link forms outside code", () => {
    expect(markdownLinks(`
[Inline](./guide.md#install)
[Nested](./api_(stable).md)
[Reference][guide]
[Shortcut]
![Image](/images/diagram.png)
<img data-src="/images/metadata.png" src="/images/html-diagram.png" alt="HTML diagram">
<img data-note=" src=&quot;/images/decoy.png&quot;" src="/images/actual.png">
:u-button[Guide]{to="/docs/inline"}
:u-avatar[]{src="/images/avatar.png"}
::card
---
to: /docs/card
src: /images/card.png
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
::card
---
to: "#install"
---
::
<a href="/docs/html">HTML</a>
<https://vitehub.dev/docs/autolink>
https://vitehub.dev/docs/bare-autolink

[guide]: /docs/guide
[shortcut]: /docs/shortcut

\`[ignored](./missing.md)\`
\`\`[also ignored](./missing.md)\`\`
\`\`\`
[ignored](./missing.md)
\`\`\`
\`\`\`\`
[also ignored](./missing.md)
\`\`\`\`
`)).toEqual([
      "./guide.md#install",
      "./api_(stable).md",
      "/docs/guide",
      "/images/diagram.png",
      "/images/html-diagram.png",
      "/images/actual.png",
      "/docs/inline",
      "/images/avatar.png",
      "/docs/card",
      "/images/card.png",
      "/docs/card#install",
      "#install",
      "/docs/html",
      "https://vitehub.dev/docs/autolink",
      "https://vitehub.dev/docs/bare-autolink",
    ]);
  });

  it("uses rendered block boundaries for code and list continuations", () => {
    expect(markdownLinks(`\`first

# [Heading](/docs/heading)

[Rendered](/docs/rendered)

\`last

    [Indented](/docs/ignored)
\t[Tabbed](/docs/also-ignored)

- Item

    [Nested](/docs/nested)`)).toEqual(["/docs/heading", "/docs/rendered", "/docs/nested"]);
  });

  it("ignores links in HTML comments", () => {
    expect(markdownLinks("<!-- [Draft](/docs/missing) -->")).toEqual([]);
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
    expect([...markdownAnchors("# A--B\n\n# A-B")]).toEqual(["a-b", "a-b-1"]);
    expect([...markdownAnchors("Install\n---")]).toEqual(["install"]);
    expect([...markdownAnchors("---\ntitle: Guide\n---\n\n# Install")]).toEqual(["install"]);
  });

  it("uses GitHub anchors for public package READMEs", () => {
    expect([...markdownAnchors("# 123 start\n\n# --trim--\n\n# A---B\n\n# &#x20;a\n\n# v½\n\n# under‿score\n\n# alpha <em>bravo</em> charlie", { renderer: "github" })]).toEqual([
      "123-start",
      "--trim--",
      "a---b",
      "-a",
      "v",
      "under‿score",
      "alpha-bravo-charlie",
    ]);

    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[Numeric](#123-start)\n\n## 123 start",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("uses GitHub parsing for public package README destinations", () => {
    expect(markdownLinks(':u-button[Example]{to="/docs/missing"}', { renderer: "github" })).toEqual([]);

    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": ':u-button[Example]{to="/docs/missing"}',
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("accepts explicit HTML anchors in docs content", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": '# Docs\n\n[Install](#install)\n[Legacy](#legacy)\n\n<h2 data-note=" id=decoy" id="install">Install</h2>\n<a id=legacy></a>\n\n[Decoy](#decoy)',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #decoy does not exist"),
    ]);
  });

  it("accepts relative routes and anchors across docs and public package READMEs", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Guide](/docs/guide#install)\n[Repeated](/docs/guide#install-1)",
      "docs/content/docs/guide.md": "# Guide\n\n## Install\n\n## Install\n\n## 123 start",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[Source](../../docs/content/docs/guide.md#123-start)\n[Site](https://vitehub.dev/docs/guide#_123-start)",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [], files: 3 });
  });

  it("preserves ordered filenames in docs routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Install](/docs/reference/1.install#setup)",
      "docs/content/docs/reference/1.install.md": "# Install\n\n## Setup",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("resolves relative links from the deployed page URL", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Wrong](./guide)",
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/guide" does not exist'),
    ]);
  });

  it("accepts root-served public assets", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Logo](/vitehub-logo.svg)",
      "docs/public/vitehub-logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("accepts relative links to public assets", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Logo](../vitehub-logo.svg)",
      "docs/public/vitehub-logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("reports missing rendered images", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n![Diagram](/images/missing.png)\n\n<img src=\"/images/missing-html.png\" alt=\"Missing\">",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/images/missing.png" does not exist'),
      expect.stringContaining('route "/images/missing-html.png" does not exist'),
    ]);
  });

  it("reports missing frontmatter images", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/blog/post.md": "---\ntitle: Post\nimage: /images/missing-cover.png\n---\n\n# Post",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/images/missing-cover.png" does not exist'),
    ]);
  });

  it("parses schema-defined frontmatter links without scanning scalar text", () => {
    expect(markdownLinks(`---
image: /images/cover.png
links:
  - label: Guide
    to: /docs/guide
authors:
  - name: Writer
    to: /authors/writer
    avatar:
      src: /images/writer.png
description: |
  src: /images/not-rendered.png
  to: /docs/not-rendered
  [Draft](/docs/missing)
---

# Post`)).toEqual([
      "/images/cover.png",
      "/docs/guide",
      "/images/writer.png",
      "/authors/writer",
    ]);
  });

  it("maps only configured content collections to routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><h1>Home</h1></template>",
      "docs/content/index.md": "# Orphan",
      "docs/content/docs/index.md": "# Docs\n\n[Wrong landing anchor](/#orphan)",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({
      errors: [expect.stringContaining('anchor #orphan does not exist for route "/"')],
      files: 1,
    });
  });

  it("accepts static anchors rendered by application page components", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LandingPaths /></template>",
      "docs/app/components/landing/Paths.vue": '<template><section id="start" /></template>',
      "docs/content/docs/index.md": "# Docs\n\n[Start](/#start)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("does not treat dynamic application page patterns as concrete routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/app/pages/docs/[...slug].vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Pattern](/docs/[...slug])",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/[...slug]" does not exist'),
    ]);
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

  it("reports missing inline MDC, block MDC, and HTML routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": `# Docs

:u-button[Missing]{to="/docs/missing-inline"}

::card
---
to: /docs/missing-card
---
::

<a href="/docs/missing-html">Missing</a>`,
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-inline" does not exist'),
      expect.stringContaining('route "/docs/missing-card" does not exist'),
      expect.stringContaining('route "/docs/missing-html" does not exist'),
    ]);
  });

  it("reports missing same-site autolink routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n<https://vitehub.dev/docs/missing>",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing" does not exist'),
    ]);
  });

  it("validates protocol-relative same-site routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Missing](//vitehub.dev/docs/missing)\n[External](//example.com/missing)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing" does not exist'),
    ]);
  });

  it("does not rewrite rendered index routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Missing](/docs/index)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/index" does not exist'),
    ]);
  });

  it("validates same-site links in the repository README", () => {
    const repoRoot = fixture({
      "README.md": "# ViteHub\n\n[Missing](https://vitehub.dev/docs/missing)",
      "docs/app/pages/index.vue": "<template />",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({
      errors: [expect.stringContaining('route "/docs/missing" does not exist')],
      files: 1,
    });
  });

  it("reports rendered .md routes that the browser cannot resolve", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Guide](./guide.md)",
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/guide.md" does not exist'),
    ]);
  });

  it("accepts generated raw documentation routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Raw index](/raw/docs.md)\n[Raw guide](/raw/docs/guide.md)",
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("reports missing anchors in rendered MDC destinations", () => {
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
::

::card
---
to: "#quoted-missing"
---
::`,
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #missing does not exist"),
      expect.stringContaining("anchor #quoted-missing does not exist"),
    ]);
  });

  it("does not accept public directories as asset targets", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Images](/images)",
      "docs/public/images/logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/images" does not exist'),
    ]);
  });
});

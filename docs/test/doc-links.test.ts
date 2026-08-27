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
[Duplicate][]
![Image](/images/diagram.png)
<img data-src="/images/metadata.png" src="/images/html-diagram.png" alt="HTML diagram">
<img data-note=" src=&quot;/images/decoy.png&quot;" src="/images/actual.png">
<picture><source srcset="/images/dark.png 1x, /images/dark@2x.png 2x"><img src="/images/fallback.png"></picture>
<source srcset="data:image/svg+xml,%3Csvg%3E 1x, /images/local-after-data.png 2x">
<video poster="/images/poster.png" src="/media/demo.mp4"><track src="/media/captions.vtt"></video>
<audio src="/media/audio.mp3"></audio><iframe src="/examples/demo.html"></iframe>
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
<a href="/docs/html&#35;install">HTML</a>
<a href="/docs/literal&notit=bar">Attribute entity</a>
<https://vitehub.dev/docs/autolink>
https://vitehub.dev/docs/bare-autolink

[guide]: /docs/guide
[shortcut]: /docs/shortcut
[duplicate]: /docs/first
[duplicate]: /docs/second

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
      "/docs/first",
      "/images/diagram.png",
      "/images/html-diagram.png",
      "/images/actual.png",
      "/images/dark.png",
      "/images/dark@2x.png",
      "/images/fallback.png",
      "data:image/svg+xml,%3Csvg%3E",
      "/images/local-after-data.png",
      "/images/poster.png",
      "/media/demo.mp4",
      "/media/captions.vtt",
      "/media/audio.mp3",
      "/examples/demo.html",
      "/docs/inline",
      "/images/avatar.png",
      "/docs/card",
      "/images/card.png",
      "/docs/card#install",
      "#install",
      "/docs/html#install",
      "/docs/literal&notit=bar",
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
    expect(markdownLinks(`<!-- [Draft](/docs/missing) -->
<!-- <a href="/docs/commented">Commented</a> --><a href="/docs/rendered">Rendered</a>
<!-- <img src="/images/commented.png"> --><img src="/images/rendered.png">`)).toEqual([
      "/docs/rendered",
      "/images/rendered.png",
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

  it("rejects public README targets outside the repository", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "[Host file](../../../../etc/passwd)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('file "../../../../etc/passwd" is outside the repository'),
    ]);
  });

  it("decodes repository-relative URL paths before lookup", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "[Notes](../release%20notes/README.md)",
      "packages/release notes/README.md": "# Notes",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("accepts explicit HTML anchors in docs content", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": '# Docs\n\n[Install](#install)\n[Legacy](#legacy)\n[Named](#named)\n\n<h2 data-note=">" id="install">Install</h2>\n<a id=legacy></a>\n<a name="named"></a>\n\n[Decoy](#decoy)',
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

  it("uses content anchors when a docs application route renders Markdown", () => {
    const repoRoot = fixture({
      "docs/app/pages/docs/index.vue": "<template><ContentRenderer /></template>",
      "docs/content/docs/index.md": "# Docs\n\n[Find](/docs#find-what-you-need)\n\n## Find what you need",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("validates GitHub anchors when a README links to a package directory", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[Usage](../other#usage)\n[Missing](../other#missing)",
      "packages/other/package.json": JSON.stringify({ name: "other" }),
      "packages/other/README.md": "# Other\n\n## Usage",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #missing does not exist in packages/other/README.md"),
    ]);
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

  it("rejects slash-suffixed public asset URLs", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Logo](/vitehub-logo.svg/)",
      "docs/public/vitehub-logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/vitehub-logo.svg" does not exist'),
    ]);
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

  it("excludes application anchors and components inside HTML comments", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<template><!-- <section id="retired" /><Retired /> --><section id="current" /></template>',
      "docs/app/components/Retired.vue": '<template><section id="nested-retired" /></template>',
      "docs/content/docs/index.md": "# Docs\n\n[Retired](/#retired)\n[Nested retired](/#nested-retired)\n[Current](/#current)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #retired does not exist"),
      expect.stringContaining("anchor #nested-retired does not exist"),
    ]);
  });

  it("preserves repeated slashes in rendered route destinations", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Broken](/docs//guide)",
      "docs/content/docs/guide.md": "# Guide",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs//guide" does not exist'),
    ]);
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

  it("normalizes every trailing slash on rendered routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Docs](/docs///)",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
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

  it("does not resolve README root-relative links as repository files", () => {
    const repoRoot = fixture({
      "README.md": "# ViteHub\n\n[Rendered host path](/packages/example)",
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example", private: true }),
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [], checked: 0 });
  });

  it("validates source-set assets in public READMEs", () => {
    const repoRoot = fixture({
      "README.md": '<picture><source srcset="./dark.svg 1x, ./dark@2x.svg 2x"><img src="./fallback.svg"></picture>',
      "docs/app/pages/index.vue": "<template />",
      "fallback.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('file "./dark.svg" does not exist'),
      expect.stringContaining('file "./dark@2x.svg" does not exist'),
    ]);
  });

  it("uses only ASCII whitespace to delimit source-set candidates", () => {
    expect(markdownLinks('<source srcset="./a\u00a0b.png 1x, ./second.png 2x">', { renderer: "github" })).toEqual([
      "./a\u00a0b.png",
      "./second.png",
    ]);
  });

  it("uses anchors rendered by the support matrix component", () => {
    const repoRoot = fixture({
      "docs/app/components/SupportMatrix.vue": '<script>const sections = [{ anchor: "runtime" }]</script><template><section id="qualifications" /></template>',
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Runtime](/docs/frameworks-hosts/support-matrix#runtime)\n[Missing](/docs/frameworks-hosts/support-matrix#markdown-only)",
      "docs/content/docs/frameworks-hosts/support-matrix.md": "# Matrix\n\n## Markdown only",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #markdown-only does not exist"),
    ]);
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

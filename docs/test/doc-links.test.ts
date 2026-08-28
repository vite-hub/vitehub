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
    expect([...markdownAnchors(":span[Install]{#install}\n\n::card{#details}\nDetails\n::\n\n::card\n---\nid: reference\n---\nReference\n::")]).toEqual([
      "install",
      "details",
      "reference",
    ]);
  });

  it("uses GitHub anchors for public package READMEs", () => {
    expect([...markdownAnchors("# 123 start\n\n# --trim--\n\n# A---B\n\n# &#x20;a\n\n# v½\n\n# under‿score\n\n# alpha <em>bravo</em> charlie\n\n<a name=custom></a>", { renderer: "github" })]).toEqual([
      "123-start",
      "--trim--",
      "a---b",
      "-a",
      "v",
      "under‿score",
      "alpha-bravo-charlie",
      "custom",
    ]);

    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/README.md": "# Example\n\n[Numeric](#123-start)\n[Custom](#custom)\n\n## 123 start\n\n<a name=custom></a>",
    });

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [] });
  });

  it("validates static links rendered by Vue application files", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/app/components/AppHeader.vue": `<script setup>
// const retiredLinks = [{ to: "/docs/commented-script" }]
const links = [{ to: "/docs/missing-script" }]
</script>
<template>
  <NuxtLink to="/docs/missing-template" />
  <NuxtLink :to="'/docs/missing-bound'" />
  <img src="/images/missing.png" />
  <NuxtLink :to="dynamicTarget" />
</template>`,
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-script" does not exist'),
      expect.stringContaining('route "/docs/missing-template" does not exist'),
      expect.stringContaining('route "/docs/missing-bound" does not exist'),
      expect.stringContaining('route "/images/missing.png" does not exist'),
    ]);
  });

  it("validates relative and locally bound Vue destinations", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<script setup>const target = "/missing-bound"</script><template><NuxtLink href="./missing-relative" /><NuxtLink :to="target" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-relative" does not exist'),
      expect.stringContaining('route "/missing-bound" does not exist'),
    ]);
  });

  it("validates object routes and ignores reassigned mutable bindings", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": `<script setup>
const objectTarget = "/missing-object"
let mutableTarget = "/missing-stale"
mutableTarget = dynamicTarget
</script><template>
<NuxtLink :to="{ path: objectTarget }" />
<NuxtLink v-bind:to="'/missing-long-form'" />
<NuxtLink :to="{ path: '/docs', hash: '#missing-anchor' }" />
<NuxtLink :to="mutableTarget" />
</template>`,
      "docs/content/docs/index.md": "# Docs",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-object" does not exist'),
      expect.stringContaining('route "/missing-long-form" does not exist'),
      expect.stringContaining("anchor #missing-anchor does not exist"),
    ]);
  });

  it("checks relative navigation on every route and resolves SFC resources from the component", () => {
    const repoRoot = fixture({
      "docs/app/pages/alpha/page.vue": "<template><NestedSharedLinks /></template>",
      "docs/app/pages/beta/page.vue": "<template><NestedSharedLinks /></template>",
      "docs/app/pages/alpha/child.vue": "<template />",
      "docs/app/components/nested/SharedLinks.vue": '<template><NuxtLink to="./child" /><img src="../logo.svg" /></template>',
      "docs/app/components/logo.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/beta/child" does not exist'),
    ]);
  });

  it("follows link data imported through both Nuxt source aliases", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": `<script setup>
import { links as tildeLinks } from "~/data/tilde-links"
import { links as atLinks } from "@/data/at-links"
</script>
<template>
  <NuxtLink v-for="link in tildeLinks" :to="link.to" />
  <NuxtLink v-for="link in atLinks" :to="link.to" />
</template>`,
      "docs/app/data/tilde-links.ts": 'export const links = [{ to: "/missing-tilde-import" }]',
      "docs/app/data/at-links.ts": 'export const links = [{ to: "/missing-at-import" }]',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-tilde-import" does not exist'),
      expect.stringContaining('route "/missing-at-import" does not exist'),
    ]);
  });

  it("resolves SFC resources through both Nuxt source aliases", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<template><img src="~/assets/tilde.svg" /><img src="@/assets/at.svg" /></template>',
      "docs/app/assets/tilde.svg": "<svg />",
      "docs/app/assets/at.svg": "<svg />",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("validates rendered aliased link fields without scanning unused exports", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LandingPaths /></template>",
      "docs/app/components/landing/Paths.vue": '<script setup lang="ts">import { links } from "./content"</script><template><NuxtLink v-for="link in links" :to="link.tutorialPath" /></template>',
      "docs/app/components/landing/content.ts": 'export const links = [{ tutorialPath: "/docs/missing-imported" }]; export const unused = [{ to: "#missing-unused" }]',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-imported" does not exist'),
    ]);
  });

  it("scopes tuple and reused loop aliases to their rendered collections", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LoopLinks /></template>",
      "docs/app/components/LoopLinks.vue": `<script setup>
import { firstLinks, secondLinks, tupleLinks } from "./links"
</script><template>
<NuxtLink v-for="(item, index) in tupleLinks" :key="index" :to="item.destination" />
<div v-for="item in firstLinks"><NuxtLink :to="item.destination" /></div>
<div v-for="item in secondLinks"><NuxtLink :to="item.target" /></div>
</template>`,
      "docs/app/components/links.ts": `
export const tupleLinks = [{ destination: "/missing-tuple" }]
export const firstLinks = [{ destination: "/missing-first" }]
export const secondLinks = [{ target: "/missing-second", destination: "/unused-reused-alias" }]
`,
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-tuple" does not exist'),
      expect.stringContaining('route "/missing-first" does not exist'),
      expect.stringContaining('route "/missing-second" does not exist'),
    ]);
  });

  it("validates destructured Vue loop destinations", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LoopLinks /></template>",
      "docs/app/components/LoopLinks.vue": '<script setup>import { links } from "./links"</script><template><NuxtLink v-for="{ tutorialPath: destination } in links" :to="destination" /></template>',
      "docs/app/components/links.ts": 'export const links = [{ tutorialPath: "/missing-destructured" }]',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-destructured" does not exist'),
    ]);
  });

  it("tracks destructured loop aliases with an index", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LoopLinks /></template>",
      "docs/app/components/LoopLinks.vue": '<script setup>import { links } from "./links"</script><template><NuxtLink v-for="({ tutorialPath: destination }, index) in links" :key="index" :to="destination" /></template>',
      "docs/app/components/links.ts": 'export const links = [{ tutorialPath: "/missing-destructured-index" }]',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-destructured-index" does not exist'),
    ]);
  });

  it("does not let void elements extend Vue loop scopes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LoopLinks /></template>",
      "docs/app/components/LoopLinks.vue": `<script setup>
import { rendered, unused } from "./links"
</script><template>
<div v-for="item in unused"><img src="/logo.svg"></div>
<NuxtLink to="/missing-rendered" /><NuxtLink :to="item.destination" />
</template>`,
      "docs/app/components/links.ts": `
export const rendered = [{ destination: "/missing-rendered" }]
export const unused = [{ destination: "/missing-unused" }]
`,
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/logo.svg" does not exist'),
      expect.stringContaining('route "/missing-rendered" does not exist'),
    ]);
  });

  it("validates aliased link fields declared in the rendering Vue file", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<script setup>const items = [{ destination: "/docs/missing-local" }]; const unused = [{ destination: "/docs/missing-unused" }]</script><template><NuxtLink v-for="item in items" :to="item.destination" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-local" does not exist'),
    ]);
  });

  it("resolves constant-backed imported destinations", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<script setup>import { links } from "../links"</script><template><NuxtLink v-for="link in links" :to="link.to" /></template>',
      "docs/app/links.ts": 'import { target, unused } from "./targets"; export const links = [{ to: target }]',
      "docs/app/targets.ts": 'export const target = "/docs/missing-constant"; export const unused = "/docs/missing-unused"',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/missing-constant" does not exist'),
    ]);
  });

  it("validates URLs rendered from Nuxt configuration", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/nuxt.config.ts": 'export default defineNuxtConfig({ app: { head: { link: [{ href: "/missing-icon.ico" }] } } })',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-icon.ico" does not exist'),
    ]);
  });

  it("follows selected links through local re-exports and functions", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LandingPaths /></template>",
      "docs/app/components/LandingPaths.vue": '<script setup>import { links } from "./barrel"</script><template><NuxtLink v-for="link in links()" :to="link.to" /></template>',
      "docs/app/components/barrel.ts": 'export * from "./named"',
      "docs/app/components/named.ts": 'export { links } from "./content"',
      "docs/app/components/content.ts": 'export function links() { return [{ to: "/missing-reexported" }] }',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-reexported" does not exist'),
    ]);
  });

  it("follows selected default declarations through local re-exports", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LandingPaths /></template>",
      "docs/app/components/LandingPaths.vue": '<script setup>import links from "./barrel"</script><template><NuxtLink v-for="link in links()" :to="link.to" /></template>',
      "docs/app/components/barrel.ts": 'export { default } from "./content"',
      "docs/app/components/content.ts": 'export default function links() { return [{ to: "/missing-default" }] }',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-default" does not exist'),
    ]);
  });

  it("resolves fragment-only component links against the route that renders them", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<template><section id="home" /></template>',
      "docs/app/pages/examples.vue": '<template><ExamplesNavigation /><section id="catalog" /></template>',
      "docs/app/components/ExamplesNavigation.vue": '<template><NuxtLink to="#catalog" /><NuxtLink to="#missing" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('anchor #missing does not exist for route "/examples"'),
    ]);
  });

  it("associates kebab-case component tags with their rendered route", () => {
    const repoRoot = fixture({
      "docs/app/pages/examples/page.vue": '<template><shared-links /></template>',
      "docs/app/pages/examples/child.vue": "<template />",
      "docs/app/components/SharedLinks.vue": '<template><NuxtLink to="./child" /><NuxtLink to="#missing" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('anchor #missing does not exist for route "/examples/page"'),
    ]);
  });

  it("associates selected Nuxt layouts with every rendered docs route", () => {
    const repoRoot = fixture({
      "docs/app/pages/docs/[...slug].vue": '<script setup>definePageMeta({ layout: "docs" })</script><template />',
      "docs/app/layouts/docs.vue": '<template><NuxtLink to="./child" /><NuxtLink to="#missing" /><slot /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot, docsRoutes: ["/docs/guide", "/docs/guide/child"] }).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('anchor #missing does not exist for route "/docs/guide"'),
        expect.stringContaining('route "/docs/child" does not exist'),
        expect.stringContaining('anchor #missing does not exist for route "/docs/guide/child"'),
      ]),
    );
  });

  it("does not associate catch-all sources with routes owned by static pages", () => {
    const repoRoot = fixture({
      "docs/app/pages/[...slug].vue": '<template><CatchAllNavigation /><section id="guide" /></template>',
      "docs/app/pages/index.vue": '<template><section id="home" /></template>',
      "docs/app/components/CatchAllNavigation.vue": '<template><NuxtLink to="#guide" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot, docsRoutes: ["/", "/guide"] }).errors).toEqual([]);
  });

  it("associates dynamic application pages with every rendered content collection route", () => {
    const repoRoot = fixture({
      "docs/app/pages/[slug].vue": '<template><section id="trust" /><NuxtLink to="#missing-trust" /></template>',
      "docs/app/pages/blog/[...slug].vue": '<template><section id="post" /><NuxtLink to="#missing-blog" /></template>',
      "docs/content/blog/post.md": "# Post",
      "docs/content/trust/privacy.md": "# Privacy",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('anchor #missing-blog does not exist for route "/blog/post"'),
      expect.stringContaining('anchor #missing-trust does not exist for route "/privacy"'),
    ]));
  });

  it("does not invent a route for fragment-only links in unassociated components", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<template><section id="home" /></template>',
      "docs/app/components/SharedNavigation.vue": '<template><NuxtLink to="#missing" /><NuxtLink to="./unknown" /><NuxtLink to="/missing-absolute" /></template>',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-absolute" does not exist'),
    ]);
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

    expect(validateDocumentationLinks({ repoRoot })).toMatchObject({ errors: [], files: 4 });
  });

  it("uses content anchors when a docs application route renders Markdown", () => {
    const repoRoot = fixture({
      "docs/app/pages/docs/index.vue": '<template><NuxtLink to="#find-what-you-need" /><NuxtLink to="#missing" /><ContentRenderer /></template>',
      "docs/content/docs/index.md": "# Docs\n\n## Find what you need",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining("anchor #missing does not exist"),
    ]);
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

  it("validates schema-defined links in YAML docs pages", () => {
    const repoRoot = fixture({
      "docs/app/pages/docs/[...slug].vue": "<template><ContentRenderer /></template>",
      "docs/content/docs/guide.yaml": "title: Guide\nimage: /images/missing.png\nlinks:\n  - label: Missing\n    to: /docs/missing\n",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/images/missing.png" does not exist'),
      expect.stringContaining('route "/docs/missing" does not exist'),
    ]);
  });

  it("excludes navigation metadata while retaining YAML docs routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/docs/[...slug].vue": "<template><ContentRenderer /></template>",
      "docs/content/docs/index.md": "# Docs\n\n[Guide](/docs/guide)\n[Metadata](/docs/reference/.navigation)\n",
      "docs/content/docs/guide.yaml": "title: Guide\n",
      "docs/content/docs/reference/.navigation.yml": "title: Reference\n",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/docs/reference/.navigation" does not exist'),
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
      files: 2,
    });
  });

  it("accepts static anchors rendered by application page components", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template><LandingPaths /></template>",
      "docs/app/components/landing/Paths.vue": '<script setup>const details = "details"</script><template><section id="start" /><section :id="details" /><section v-bind:id="\'finish\'" /></template>',
      "docs/content/docs/index.md": "# Docs\n\n[Start](/#start)\n[Details](/#details)\n[Finish](/#finish)",
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

  it("normalizes dot segments in root-relative routes", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": "<template />",
      "docs/content/docs/index.md": "# Docs\n\n[Install](/docs/guide/../installation)",
      "docs/content/docs/installation.md": "# Installation",
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([]);
  });

  it("validates same-site URLs emitted by metadata helpers", () => {
    const repoRoot = fixture({
      "docs/app/pages/index.vue": '<script setup>useSchemaOrg([defineOrganization({ url: "https://vitehub.dev", logo: "https://vitehub.dev/missing-logo.png" })])</script><template />',
    });

    expect(validateDocumentationLinks({ repoRoot }).errors).toEqual([
      expect.stringContaining('route "/missing-logo.png" does not exist'),
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
      files: 2,
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

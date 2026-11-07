import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkDocsLinks } from "../src/check-links.ts";

function output(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "docs-links-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), contents);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("built docs links", () => {
  it("validates fragments on other pages, including encoded ids and flat HTML output", () => {
    output(
      {
        "index.html": '<a href="/guide#caf%C3%A9">Guide</a>',
        "guide.html": '<h2 id="café">Café</h2>',
      },
      (dir) => {
        expect(checkDocsLinks({ dir, siteUrl: "https://docs.test" })).toEqual({ pages: 2 });
        writeFileSync(join(dir, "guide.html"), '<h2 id="intro">Introduction</h2>');
        expect(() => checkDocsLinks({ dir, siteUrl: "https://docs.test" })).toThrow(
          'no element with id "café"',
        );
      },
    );
  });

  it.each(["/", "/portal/"])("preserves flat page slugs ending in index under %s", (appBase) => {
    output(
      {
        "search-index.html": '<h2 id="intro">Introduction</h2><a href="#intro">Introduction</a>',
        "docs/search-index.html": '<h2 id="intro">Introduction</h2><a href="#intro">Introduction</a>',
      },
      (dir) => {
        expect(checkDocsLinks({ dir, siteUrl: "https://docs.test", appBase }).pages).toBe(2);
        writeFileSync(join(dir, "docs/search-index.html"), '<a href="#intro">Introduction</a>');
        expect(() => checkDocsLinks({ dir, siteUrl: "https://docs.test", appBase })).toThrow(
          `links to ${appBase}docs/search-index#intro, but that page has no element with id "intro"`,
        );
      },
    );
  });

  it("resolves relative links, directory indexes, base URLs, assets and app prefixes", () => {
    output(
      {
        "guide/index.html":
          '<base href="/portal/guide/"><a href="../next/#yes">Next</a><img src="/portal/image.svg">',
        "next/index.html": '<h2 id="yes">Yes</h2>',
        "image.svg": "<svg/>",
      },
      (dir) => {
        expect(
          checkDocsLinks({ dir, siteUrl: "https://docs.test", appBase: "/portal/" }).pages,
        ).toBe(2);
      },
    );
  });

  it.each(["/", "/portal/"])("resolves relative base URLs from the page URL under %s", (appBase) => {
    output(
      {
        "guide/index.html": '<base href="./assets/"><a href="next/#yes">Next</a><img src="image.svg">',
        "guide/assets/next/index.html": '<h2 id="yes">Yes</h2>',
        "guide/assets/image.svg": "<svg/>",
      },
      (dir) => {
        expect(checkDocsLinks({ dir, siteUrl: "https://docs.test", appBase }).pages).toBe(2);
        writeFileSync(join(dir, "guide/assets/next/index.html"), '<h2 id="other">Other</h2>');
        expect(() => checkDocsLinks({ dir, siteUrl: "https://docs.test", appBase })).toThrow(
          'no element with id "yes"',
        );
      },
    );
  });

  it("allows dynamic endpoints and state fragments, skips embeds and ignores inert custom src attributes", () => {
    output(
      {
        "index.html":
          '<include src="partial.md"></include><a href="/play#state">Play</a><img src="/badge.svg">',
        "play.html": "<p>Play</p>",
        "embed/frame.html": '<a href="/missing">Broken example</a>',
      },
      (dir) => {
        expect(
          checkDocsLinks({
            dir,
            siteUrl: "https://docs.test",
            excludeLinks: ["/badge.svg"],
            excludePages: [/^\/embed\//],
            ignoreFragments: ["/play"],
          }).pages,
        ).toBe(2);
      },
    );
  });

  it.each(["/", "/portal/"])("matches glob exclusions without hiding neighboring paths under %s", (appBase) => {
    output(
      { "index.html": `<a href="${appBase}blog/post#intro">Post</a><img src="${appBase}media/icon.svg">` },
      (dir) => {
        const options = { dir, siteUrl: "https://docs.test", appBase, excludeLinks: [`${appBase}blog/**`, `${appBase}media/*.svg`] };
        expect(checkDocsLinks(options).pages).toBe(1);
        writeFileSync(join(dir, "index.html"), `<a href="${appBase}blogger/post">Missing</a>`);
        expect(() => checkDocsLinks(options)).toThrow(/no page or file/);
      },
    );
  });

  it("matches extglob exclusions without hiding neighboring paths", () => {
    output({ "index.html": '<a href="/guide">Guide</a><a href="/api">API</a>' }, (dir) => {
      const options = { dir, siteUrl: "https://docs.test", excludeLinks: ["/@(guide|api)"] };
      expect(checkDocsLinks(options).pages).toBe(1);
      writeFileSync(join(dir, "index.html"), '<a href="/blog">Blog</a>');
      expect(() => checkDocsLinks(options)).toThrow(/no page or file/);
    });
  });

  it("matches an exclusion with glob characters as written too", () => {
    output({ "index.html": '<a href="/files/[id].json">Template</a>' }, (dir) => {
      expect(checkDocsLinks({ dir, siteUrl: "https://docs.test", excludeLinks: ["/files/[id].json"] }).pages).toBe(1);
    });
  });

  it("reports missing files, malformed fragments and app redirects instead of following obsolete links", () => {
    output(
      { "index.html": '<a href="/old">Old</a><img src="/missing.png"><a href="/#%ZZ">Invalid</a>' },
      (dir) => {
        expect(() =>
          checkDocsLinks({
            dir,
            siteUrl: "https://docs.test",
            redirect: (url) => (url.pathname === "/old" ? "/new" : undefined),
          }),
        ).toThrow(/redirects to \/new/);
        expect(() => checkDocsLinks({ dir, siteUrl: "https://docs.test" })).toThrow(
          /no page or file/,
        );
      },
    );
  });
});

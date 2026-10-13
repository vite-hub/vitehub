import { describe, expect, it } from "vitest";
import { sitemapUrls } from "../server/utils/sitemap";

describe("sitemap", () => {
  it("emits unique paths in the canonical form", () => {
    const urls = sitemapUrls([
      { path: "/" },
      { path: "/guides/" },
      { path: "/docs/agents" },
      { path: "/docs/agents/" },
      { path: "/docs/agents/.navigation" },
    ]);

    expect(urls).toEqual([
      { loc: "/" },
      { loc: "/docs/agents" },
      { loc: "/guides" },
    ]);
  });

  it("keeps the date part of the last modification", () => {
    const urls = sitemapUrls([
      { path: "/docs/kv" },
      { path: "/docs/kv/", lastmod: "2026-07-11T10:00:00.000Z" },
    ]);

    expect(urls).toEqual([{ loc: "/docs/kv", lastmod: "2026-07-11" }]);
  });
});

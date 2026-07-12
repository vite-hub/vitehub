import { describe, expect, it } from "vitest";
import { generateSitemap } from "../server/utils/sitemap";

describe("sitemap", () => {
  it("emits unique absolute URLs with the site's trailing-slash policy", () => {
    const sitemap = generateSitemap(
      [
        { path: "/" },
        { path: "/blog" },
        { path: "/blog/agents" },
        { path: "/blog/agents/" },
        { path: "/docs/agents/.navigation" },
      ],
      "https://vitehub.dev/",
    );

    expect(sitemap).toContain("<loc>https://vitehub.dev/</loc>");
    expect(sitemap).toContain("<loc>https://vitehub.dev/blog/</loc>");
    expect(sitemap).toContain("<loc>https://vitehub.dev/blog/agents/</loc>");
    expect(sitemap.match(/blog\/agents/g)).toHaveLength(1);
    expect(sitemap).not.toContain(".navigation");
  });

  it("keeps dates and escapes XML values", () => {
    const sitemap = generateSitemap(
      [{ path: "/docs/a&b", lastmod: "2026-07-11T10:00:00.000Z" }],
      "https://vitehub.dev",
    );

    expect(sitemap).toContain("<loc>https://vitehub.dev/docs/a&amp;b/</loc>");
    expect(sitemap).toContain("<lastmod>2026-07-11</lastmod>");
  });
});

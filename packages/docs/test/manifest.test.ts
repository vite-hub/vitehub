import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { github, glob } from "@vite-hub/source"
import { describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { createDocsContent, createDocsManifest, DocsContentError, readDocsContent } from "../src/manifest.ts"
import { docsManifestPages, findDocsPage } from "../src/navigation.ts"

import type { DocsManifest } from "../src/types.ts"

async function withContent(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vitehub-docs-manifest-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), contents)
    }
    await run(dir)
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

async function manifestOf(files: Record<string, string>, base = "/docs"): Promise<DocsManifest> {
  let manifest: DocsManifest | undefined
  await withContent(files, async (dir) => {
    manifest = await createDocsManifest({ dir, base })
  })
  return manifest!
}

describe("createDocsManifest", () => {
  it("mounts independent sources, excludes partials, adapts metadata and preserves physical file paths", async () => {
    await withContent(
      {
        "pages/index.md": "---\ntitle: Home\n---\n",
        "pages/guide/install.md": "---\ntitle: Install\n---\n",
        "package/index.md": "---\ntitle: Zoom\ncredits: Built on Vue\nkeywords: [image]\n---\n",
        "package/partials/example.md": "---\ntitle: Partial\n---\n",
        "package/usage.md": "---\ntitle: Usage\n---\n",
      },
      async (dir) => {
        const manifest = await createDocsManifest({
          dir,
          base: "/",
          sources: [
            join(dir, "pages"),
            {
              source: join(dir, "package"),
              mount: "/zoom",
              exclude: ["partials/**"],
              frontmatter: (data, page) => ({
                ...data,
                title: page.file === "usage.md" ? "Mapped usage" : data.title,
              }),
            },
          ],
          sections: { zoom: { category: "Blocks", order: -1 } },
        });
        expect(manifest.root).toMatchObject({ path: "/", source: "docs-0", file: "index.md" });
        expect(manifest.sections[0]).toMatchObject({ id: "zoom", category: "Blocks" });
        expect(findDocsPage(manifest, "/zoom")?.page).toMatchObject({
          file: "index.md",
          source: "docs-1",
          credits: "Built on Vue",
          keywords: ["image"],
        });
        expect(findDocsPage(manifest, "/zoom/usage")?.page.title).toBe("Mapped usage");
        expect(docsManifestPages(manifest).map((page) => page.path)).not.toContain(
          "/zoom/partials/example",
        );
      },
    );
  });

  it("reads a glob() Source with a mount, excludes, and a frontmatter adapter", async () => {
    await withContent(
      {
        "pages/index.md": "---\ntitle: Home\n---\n",
        "zoom/docs/index.md": "---\ntitle: Zoom\n---\n",
        "zoom/docs/guide/.navigation.yml": "title: Zoom guides\n",
        "zoom/docs/guide/install.md": "---\ntitle: Install\n---\n# Install",
        "zoom/docs/partials/note.md": "---\ntitle: Partial\n---\n",
        "zoom/docs/notes.txt": "not a page",
      },
      async (dir) => {
        const { manifest, files } = await readDocsContent({
          dir,
          base: "/zoom",
          rootDir: dir,
          sources: [
            "pages",
            {
              source: glob({ cwd: "zoom/docs", include: ["**/*.md", "**/.navigation.yml"] }),
              mount: "/zoom",
              exclude: ["partials/**"],
              frontmatter: (data, page) => ({ ...data, description: `From ${page.file} at ${page.path}` }),
            },
          ],
        })
        expect(manifest.sections.map(section => [section.id, section.title])).toEqual([["guide", "Zoom guides"]])
        expect(findDocsPage(manifest, "/zoom/guide/install")?.page).toMatchObject({
          file: "guide/install.md",
          source: "docs-1",
          description: "From guide/install.md at /zoom/guide/install",
        })
        expect(findDocsPage(manifest, "/")?.page).toMatchObject({ file: "index.md", source: "docs-0" })
        expect(docsManifestPages(manifest).map(page => page.path)).not.toContain("/zoom/partials/note")
        // The server reads a folder itself, and gets the pages of a Content Source from the build.
        expect(files.map(file => [file.source, file.file])).toEqual([["docs-1", "guide/install.md"], ["docs-1", "index.md"]])
        expect(files[0]!.markdown).toBe("---\ntitle: Install\n---\n# Install")
      },
    )
  })

  it("reads a github() Source", async () => {
    const fake = createFakeGitHub({ owner: "acme", repo: "docs" })
    vi.stubGlobal("fetch", vi.fn(fake.fetch))
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
    vi.stubEnv("FORGES_GITHUB_TOKEN", "")
    try {
      fake.commit("main", {
        "README.md": "# Not a page",
        "content/docs/index.md": "---\ntitle: Remote docs\n---\n",
        "content/docs/kv/.navigation.yml": "title: Key-value\nicon: i-lucide-database\n",
        "content/docs/kv/index.md": "---\ntitle: KV overview\n---\n# KV",
        "content/docs/kv/get.md": "---\ntitle: Get\nnavigation.order: 1\n---\n",
      })
      const { manifest, files } = await readDocsContent({
        dir: "unused",
        base: "/docs",
        sources: [github({ repo: "acme/docs", ref: "main", root: "content" })],
      })
      expect(manifest.root).toMatchObject({ title: "Remote docs", file: "docs/index.md", source: "docs-0" })
      expect(manifest.sections).toMatchObject([{ id: "kv", title: "Key-value", icon: "i-lucide-database", pages: [{ id: "index", title: "KV overview" }, { id: "get", title: "Get" }] }])
      expect(files.find(file => file.file === "docs/kv/index.md")?.markdown).toBe("---\ntitle: KV overview\n---\n# KV")
      expect(fake.requests.some(request => request.path.startsWith("/repos/acme/docs/"))).toBe(true)
    }
    finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it("names the Source path of an invalid page from a Content Source", async () => {
    await withContent({ "pages/bad.md": "---\ntitel: Bad\n---\n" }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/", rootDir: dir, sources: [glob("pages")] })).rejects.toThrow(/Invalid docs frontmatter in bad\.md/)
    })
  })

  it("rejects routes produced by different source files", async () => {
    await withContent(
      { "first/zoom.md": "---\ntitle: First\n---", "second/index.md": "---\ntitle: Second\n---" },
      async (dir) => {
        await expect(
          createDocsManifest({
            dir,
            base: "/",
            sources: [join(dir, "first"), { source: join(dir, "second"), mount: "/zoom" }],
          }),
        ).rejects.toThrow(/also produced/);
      },
    );
  });

  it.each([
    ["docs/start/guide.md", "docs/start/guide/index.md"],
    ["docs/start.md", "docs/start/index.md"],
    ["about.md", "about/index.md"],
  ])("rejects duplicate routes from %s and %s", async (first, second) => {
    await expect(manifestOf({ [first]: "---\ntitle: First\n---\n# First", [second]: "---\ntitle: Second\n---\n# Second" })).rejects.toThrow(DocsContentError)
    await expect(manifestOf({ [first]: "---\ntitle: First\n---\n# First", [second]: "---\ntitle: Second\n---\n# Second" })).rejects.toThrow(new RegExp(`${first}.*${second}|${second}.*${first}`))
  })

  it("reads sections, ordered pages, and pages outside the base", async () => {
    const manifest = await manifestOf({
      "docs/index.md": "---\ntitle: ViteHub docs\nnavigation.order: 0\n---\n\nStart here.\n",
      "docs/server-primitives/index.md": "---\ntitle: Overview\nnavigation.order: 1\n---\n\nServer content.\n",
      "docs/server-primitives/.navigation.yml": "title: Server primitives\nicon: i-lucide-server-cog\norder: 30\ncategory: Data\ngroup: Platform\nfold: true\n",
      "docs/server-primitives/kv.md": "---\ntitle: KV\nnavigation.order: 2\nnavigation.group: Storage\n---\n\nKV content.\n",
      "docs/server-primitives/middle.md": "---\ntitle: Middle\nnavigation.order: 1.5\n---\n\nOrdered between the overview and KV.\n",
      "docs/server-primitives/hidden.md": "---\ntitle: Hidden\nnavigation: false\n---\n\nHidden content.\n",
      "contact.md": "---\ntitle: Contact ViteHub\n---\n",
      "about.md": "---\ntitle: About ViteHub\n---\n",
    })

    expect(manifest.base).toBe("/docs")
    expect(manifest.root).toMatchObject({ id: "index", path: "/docs", file: "docs/index.md", title: "ViteHub docs" })
    expect(manifest.sections.map(section => section.id)).toEqual(["server-primitives"])
    expect(manifest.sections[0]).toMatchObject({
      path: "/docs/server-primitives",
      title: "Server primitives",
      icon: "i-lucide-server-cog",
      category: "Data",
      group: "Platform",
      fold: true,
      order: 30,
    })
    // The overview comes first. A page without an order sorts after the ordered ones.
    expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual([
      "/docs/server-primitives",
      "/docs/server-primitives/middle",
      "/docs/server-primitives/kv",
      "/docs/server-primitives/hidden",
    ])
    expect(manifest.sections[0]?.pages.find(page => page.id === "kv")?.group).toBe("Storage")
    expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")?.navigation).toBe(false)
    expect(manifest.pages.map(page => [page.path, page.file])).toEqual([
      ["/about", "about.md"],
      ["/contact", "contact.md"],
    ])
  })

  it("joins section and page paths without a double slash when the base is the site root", async () => {
    const manifest = await manifestOf({
      "index.md": "---\ntitle: Home\n---\n",
      "guide/index.md": "---\ntitle: Guide\n---\n",
      "guide/install.md": "---\ntitle: Install\n---\n",
    }, "/")

    expect(manifest.root?.path).toBe("/")
    expect(manifest.sections.map(section => section.path)).toEqual(["/guide"])
    expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual(["/guide", "/guide/install"])
  })

  it.each(["/", "/docs"])("retains direct Markdown pages under the base %s exactly once", async (base) => {
    const prefix = base === "/" ? "" : "docs/"
    const manifest = await manifestOf({
      [`${prefix}index.md`]: "---\ntitle: Home\n---\n",
      [`${prefix}faq.md`]: "---\ntitle: FAQ\n---\n",
      [`${prefix}guide/index.md`]: "---\ntitle: Guide\n---\n",
    }, base)
    const path = base === "/" ? "/faq" : "/docs/faq"

    expect(manifest.pages.map(page => page.path)).toEqual([path])
    expect(findDocsPage(manifest, path)?.page.file).toBe(`${prefix}faq.md`)
    expect(docsManifestPages(manifest).map(page => page.path)).toEqual([base, `${base === "/" ? "" : base}/guide`, path])
  })

  it("stops on frontmatter that does not match the schema", async () => {
    await withContent({ "docs/kv/index.md": "---\ntitle: KV\nlayout: wide\n---\n" }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(DocsContentError)
    })
  })

  it.each([
    ["layuot: landing", "layuot"],
    ["navigation:\n  titel: Guide", "titel"],
    ["seo.descriptionn: Description", "descriptionn"],
  ])("rejects unknown page fields: %s", async (fields, key) => {
    await withContent({ "docs/guide/index.md": `---\ntitle: Guide\n${fields}\n---\n` }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(DocsContentError)
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(key)
    })
  })

  it("rejects unknown section fields", async () => {
    await withContent({
      "docs/guide/index.md": "---\ntitle: Guide\n---\n",
      "docs/guide/.navigation.yml": "titel: Guide\n",
    }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(DocsContentError)
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(/\.navigation\.yml.*titel/)
    })
  })

  it("hides a page with navigation: false even when dotted keys set navigation fields", async () => {
    const manifest = await manifestOf({
      "docs/kv/index.md": "---\ntitle: KV\n---\n",
      "docs/kv/hidden.md": "---\ntitle: Hidden\nnavigation: false\nnavigation.title: Shown\n---\n",
    })

    expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")).toMatchObject({ navigation: false, title: "Hidden" })
  })

  it("stops on a .navigation.yml that is not YAML", async () => {
    await withContent({
      "docs/guide/index.md": "---\ntitle: Guide\n---\n",
      "docs/guide/.navigation.yml": "title: [Guide\n",
    }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(/\.navigation\.yml/)
    })
  })

  it("names an empty page file, which Content does not list", async () => {
    await withContent({ "docs/guide/index.md": "---\ntitle: Guide\n---\n", "docs/guide/empty.md": "" }, async (dir) => {
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(DocsContentError)
      await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toThrow(/empty\.md/)
    })
  })

  it("lists the pages and section files through Content", async () => {
    await withContent({
      "docs/guide/index.md": "---\ntitle: Guide\n---\n",
      "docs/guide/.navigation.yml": "title: Guides\n",
      "docs/guide/notes.txt": "not a page",
    }, async (dir) => {
      const content = createDocsContent([{ dir }])
      const listed = await content.list("docs_0")
      expect(listed.map(file => [file.meta.key, file.data])).toEqual([
        ["docs_0/docs/guide/.navigation.yml", { title: "Guides" }],
        ["docs_0/docs/guide/index.md", { title: "Guide" }],
      ])
    })
  })

  it("has no pages for a folder that does not exist", async () => {
    const manifest = await createDocsManifest({ dir: join(tmpdir(), "vitehub-docs-missing-folder"), base: "/docs" })
    expect(docsManifestPages(manifest)).toEqual([])
  })
})

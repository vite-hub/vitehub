import { existsSync } from "node:fs"
import { join, matchesGlob } from "node:path"

import { defineContent } from "@vite-hub/content"
import { createSource, glob } from "@vite-hub/source"
import { parseFrontmatter } from "comark/parse"
import yaml from "comark-content/plugins/yaml"

import { docsManifestPages, normalizeDocsBase } from "./navigation.ts"
import { docsPageOf, docsPagePath } from "./page.ts"
import { docsFrontmatter, docsPageSchema, docsSectionSchema } from "./schema.ts"

import type { ContentRuntime } from "@vite-hub/content"
import type { DocsSectionFile } from "./schema.ts"
import type { z } from "zod"
import type { DocsAppPage, DocsManifest, DocsPage, DocsSection } from "./types.ts"

export interface DocsSource {
  /** Content directory, absolute for createDocsManifest and relative to the app root for the Nuxt module. */
  dir: string;
  /** Public path at which this directory is mounted. Defaults to `/`. */
  mount?: string;
  /** File globs relative to this source to leave out, such as `partials/**`. */
  exclude?: string[];
  /** Adapt legacy or generated metadata before validation, without changing the source file. */
  frontmatter?: (
    data: Record<string, unknown>,
    page: { file: string; path: string; markdown: string },
  ) => Record<string, unknown>;
}

export interface DocsManifestOptions {
  /** Absolute path of the content directory. Used when sources is omitted. */
  dir: string;
  base: string;
  /** Mapped content directories. Replaces dir when supplied. */
  sources?: DocsSource[];
  /** Section metadata, overriding the corresponding .navigation.yml fields. */
  sections?: Record<string, DocsSectionFile>;
}

/** A page whose frontmatter or section file does not match the schema. The build stops on it. */
export class DocsContentError extends Error {
  constructor(file: string, issues: readonly { path: readonly PropertyKey[], message: string }[]) {
    const details = issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    super(`Invalid docs frontmatter in ${file}: ${details}`)
    this.name = "DocsContentError"
  }
}

/** The name of the Content Source of a docs source. Content names allow no `-`, so it is not the page's `docs-<index>`. */
const contentName = (index: number) => `docs_${index}`

/**
 * One `glob()` Source per docs folder, with its Markdown pages and its `.navigation.yml` files as YAML documents. The
 * manifest lists them through Content, so another Source, such as `github()`, gives the same manifest.
 */
export function createDocsContent(sources: readonly Pick<DocsSource, "dir">[]): ContentRuntime {
  return defineContent({
    route: false,
    live: false,
    // A `.navigation.yml` that does not parse stops the build, like a page whose frontmatter does not parse.
    plugins: [yaml({ onError: "throw" })],
    sources: Object.fromEntries(sources.map((source, index) => [
      contentName(index),
      // A folder that does not exist yet has no pages.
      existsSync(source.dir)
        ? () => createSource(glob({ include: ["**/*.md", "**/.navigation.yml"], dot: true }), { rootDir: source.dir })
        : { items: async () => [] },
    ])),
  })
}

interface DocsContentFile {
  /** Path in its Source, such as `guide/install.md`. */
  file: string;
  absolute: string;
  data: Record<string, unknown>;
  /** The Markdown, read only for a `frontmatter` adapter or a file that Content does not list. */
  markdown?: string;
  source: DocsSource;
  index: number;
}

/**
 * The pages and `.navigation.yml` files of each docs source, from `content.list()`. Content keys a document by its
 * URL, so it lists one of two files with the same URL, such as `guide.md` and `guide/index.md`, and no empty file.
 * Those are read from the Source, so the manifest still names both files or the empty one in a `DocsContentError`.
 */
async function listDocsContent(content: ContentRuntime, sources: readonly DocsSource[]): Promise<DocsContentFile[]> {
  const files: DocsContentFile[] = []
  for (const [index, source] of sources.entries()) {
    const name = contentName(index)
    const reader = content.getSource(name)!
    const listed = new Map((await content.list(name)).map(file => [file.meta.key.slice(name.length + 1), file.data]))
    for (const file of (await reader.keys()).sort()) {
      const navigation = file === ".navigation.yml" || file.endsWith("/.navigation.yml")
      if (!navigation && !file.endsWith(".md")) continue
      if (source.exclude?.some((pattern) => matchesGlob(file, pattern))) continue
      const markdown = !navigation && (source.frontmatter || !listed.has(file)) ? String(await reader.getItem(file)) : undefined
      const data = listed.get(file) ?? (markdown === undefined ? {} : parseFrontmatter(markdown).data)
      files.push({ file, absolute: join(source.dir, file), data, ...(markdown === undefined ? {} : { markdown }), source, index })
    }
  }
  return files
}

/** Read every docs source through Content and compute sections, pages, and their order. */
export async function createDocsManifest(options: DocsManifestOptions): Promise<DocsManifest> {
  const sources = options.sources ?? [{ dir: options.dir }];
  for (const source of sources) {
    const mount = normalizeDocsBase(source.mount ?? "/");
    if (mount.split("/").some((part) => part === "." || part === "..") || /[?#\\]/.test(mount))
      throw new Error(`Invalid docs source mount: ${mount}`);
  }
  return docsManifestOf(options, await listDocsContent(createDocsContent(sources), sources))
}

function docsManifestOf(options: DocsManifestOptions, listed: readonly DocsContentFile[]): DocsManifest {
  const base = normalizeDocsBase(options.base)
  const files = new Map<string, DocsContentFile>();
  /** The `.navigation.yml` files of each logical folder, such as `docs/kv`, in source order. */
  const folders = new Map<string, DocsContentFile[]>();
  for (const entry of listed) {
    const logical = joinPath(normalizeDocsBase(entry.source.mount ?? "/"), entry.file).slice(1);
    if (!entry.file.endsWith(".md")) {
      const folder = logical.replace(/\/?\.navigation\.yml$/, "")
      folders.set(folder, [...folders.get(folder) ?? [], entry])
      continue
    }
    const previous = files.get(logical);
    if (previous)
      throw new DocsContentError(entry.absolute, [
        { path: ["path"], message: `${logical} is also produced by ${previous.absolute}` },
      ]);
    files.set(logical, entry);
  }
  const read = (logical: string, id: string, path: string): DocsPage => {
    const entry = files.get(logical)!;
    const fields = entry.source.frontmatter
      ? entry.source.frontmatter(entry.data, { file: entry.file, path, markdown: entry.markdown ?? "" })
      : entry.data;
    return {
      ...docsPageOf(parse(entry.absolute, docsPageSchema, docsFrontmatter(fields)), {
        id,
        path,
        file: entry.file,
      }),
      ...(options.sources ? { source: `docs-${entry.index}` } : {}),
    };
  };
  const prefix = base === "/" ? "" : `${base.slice(1)}/`;
  const rootFile = `${prefix}index.md`;
  const sectionIds = [
    ...new Set(
      [...files.keys()]
        .filter((file) => file.startsWith(prefix) && file.slice(prefix.length).includes("/"))
        .map((file) => file.slice(prefix.length).split("/")[0]!),
    ),
  ];
  const sections = sectionIds
    .map((id, index): DocsSection => {
      const sectionPrefix = `${prefix}${id}/`;
      const pages = [...files.keys()]
        .filter((file) => file.startsWith(sectionPrefix))
        .map((file) => {
          const pageId = idOf(file.slice(sectionPrefix.length));
          return read(
            file,
            pageId,
            pageId === "index" ? joinPath(base, id) : joinPath(base, id, pageId),
          );
        })
        .sort((left, right) =>
          left.id === "index"
            ? -1
            : right.id === "index"
              ? 1
              : left.order - right.order || left.id.localeCompare(right.id),
        );
      let fields: DocsSectionFile = {};
      for (const file of folders.get(sectionPrefix.slice(0, -1)) ?? [])
        fields = { ...fields, ...parse(file.absolute, docsSectionSchema, file.data) };
      const navigation = parse(id, docsSectionSchema, { ...fields, ...options.sections?.[id] });
      const overview = pages.find((page) => page.id === "index");
      return {
    id,
    path: joinPath(base, id),
    title: navigation.title ?? overview?.sourceTitle ?? titleCase(id),
    description: overview?.description ?? null,
    icon: navigation.icon ?? overview?.icon ?? null,
    category: navigation.category ?? null,
    group: navigation.group ?? null,
    fold: navigation.fold ?? false,
    related: navigation.related ?? [],
    order: navigation.order ?? index,
    pages,
  }
    })
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
  const pages = [...files.keys()]
    .filter(
      (file) =>
        !file.startsWith(prefix) || (!file.slice(prefix.length).includes("/") && file !== rootFile),
    )
    .map((file) => read(file, "", docsPagePath(file)))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: DocsManifest = {
    base,
    root: files.has(rootFile) ? read(rootFile, "index", base) : null,
    sections,
    pages,
  };
  const paths = new Map<string, string>()
  for (const page of docsManifestPages(manifest)) {
    const existing = paths.get(page.path)
    if (existing)
      throw new DocsContentError(join(options.dir, page.file), [
        { path: ["path"], message: `${page.path} is also produced by ${existing}` },
      ]);
    paths.set(page.path, page.file)
  }
  return manifest
}

function parse<TOutput>(file: string, schema: z.ZodType<TOutput>, input: unknown): TOutput {
  const result = schema.safeParse(input)
  if (!result.success) throw new DocsContentError(file, result.error.issues)
  return result.data
}

/** `index.md` is the folder's page: `operations/index.md` is `operations`. */
function idOf(file: string): string {
  return (
    file
      .replaceAll("\\", "/")
      .replace(/\.md$/, "")
      .replace(/(^|\/)index$/, "") || "index"
  );
}

/**
 * The module that the app imports as `#docs/manifest`: each page with only its `DocsAppPage` fields, since every page
 * of the site loads it. The page route returns the other fields of the current page. A `sourceTitle` equal to `title`
 * is left out of the JSON and filled back when the module loads.
 */
export function docsAppManifestSource(manifest: DocsManifest): string {
  const page = (full: DocsPage): Omit<DocsAppPage, "sourceTitle"> & { sourceTitle?: string } => ({
    id: full.id,
    path: full.path,
    title: full.title,
    sourceTitle: full.sourceTitle === full.title ? undefined : full.sourceTitle,
    description: full.description,
    icon: full.icon,
    layout: full.layout,
    tutorial: full.tutorial,
    codePanel: full.codePanel,
    sidebar: full.sidebar,
    toc: full.toc,
    kind: full.kind,
    group: full.group,
    navigation: full.navigation,
    panel: full.panel,
    order: full.order,
  })
  const app = {
    ...manifest,
    root: manifest.root && page(manifest.root),
    sections: manifest.sections.map(section => ({ ...section, pages: section.pages.map(page) })),
    pages: manifest.pages.map(page),
  }
  return [
    `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(app))})`,
    "for (const page of [manifest.root, ...manifest.sections.flatMap(section => section.pages), ...manifest.pages]) if (page) page.sourceTitle ??= page.title",
    "export default manifest",
    "",
  ].join("\n")
}

/** With the base `/`, the section `guide` is `/guide`, not `//guide`. */
function joinPath(base: string, ...segments: string[]): string {
  return `${base.replace(/\/+$/, "")}/${segments.join("/")}`
}

function titleCase(input: string): string {
  return input
    .split(/[-/]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

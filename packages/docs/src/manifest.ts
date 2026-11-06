import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, matchesGlob } from "node:path";

import { parse as parseYaml } from "yaml"
import { parseFrontmatter } from "comark/parse"

import { docsManifestPages, normalizeDocsBase } from "./navigation.ts"
import { docsPageOf, docsPagePath } from "./page.ts"
import { docsFrontmatter, docsPageSchema, docsSectionSchema } from "./schema.ts"

import type { DocsSectionFile } from "./schema.ts";
import type { z } from "zod"
import type { DocsManifest, DocsPage, DocsSection } from "./types.ts"

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

/** Read the whole content directory and compute sections, pages, and their order. */
export function createDocsManifest(options: DocsManifestOptions): DocsManifest {
  const base = normalizeDocsBase(options.base)
  const sources = options.sources ?? [{ dir: options.dir }];
  const files = new Map<
    string,
    { absolute: string; file: string; source: DocsSource; index: number }
  >();
  for (const [index, source] of sources.entries()) {
    const mount = normalizeDocsBase(source.mount ?? "/");
    if (mount.split("/").some((part) => part === "." || part === "..") || /[?#\\]/.test(mount))
      throw new Error(`Invalid docs source mount: ${mount}`);
    for (const absolute of listMarkdown(source.dir)) {
      const file = relative(source.dir, absolute).replaceAll("\\", "/");
      if (source.exclude?.some((pattern) => matchesGlob(file, pattern))) continue;
      const logical = joinPath(mount, file).slice(1);
      const previous = files.get(logical);
      if (previous)
        throw new DocsContentError(absolute, [
          { path: ["path"], message: `${logical} is also produced by ${previous.absolute}` },
        ]);
      files.set(logical, { absolute, file, source, index });
    }
  }
  const read = (logical: string, id: string, path: string): DocsPage => {
    const entry = files.get(logical)!;
    const markdown = readFileSync(entry.absolute, "utf8");
    const { data } = parseFrontmatter(markdown);
    const fields = entry.source.frontmatter
      ? entry.source.frontmatter(data, { file: entry.file, path, markdown })
      : data;
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
      for (const source of sources) {
        const mount = normalizeDocsBase(source.mount ?? "/").replace(/^\/|\/$/g, "");
        const logicalDir = sectionPrefix.slice(0, -1);
        if (mount && logicalDir !== mount && !logicalDir.startsWith(`${mount}/`)) continue;
        const navigationFile = join(
          source.dir,
          mount ? logicalDir.slice(mount.length) : logicalDir,
          ".navigation.yml",
        );
        if (existsSync(navigationFile))
          fields = {
            ...fields,
            ...parse(navigationFile, docsSectionSchema, parseYaml(readFileSync(navigationFile, "utf8")) ?? {}),
          };
      }
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

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
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

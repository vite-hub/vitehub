import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  array,
  literal,
  number,
  object,
  safeParse,
  string,
} from "valibot";
import { listFiles, parseScalar, titleCase } from "./artifacts/common";
import { docsLanes, parseDocsLanes } from "./docs-lanes";
import { toRawMarkdown } from "./artifacts/raw-markdown";

type DocsArtifactOptions = {
  docsRoot: string;
  outputDir: string;
};

const docsManifestVersion = 1;
const docsManifestSchema = object({
  sections: array(
    object({
      pages: array(object({ path: string() })),
    }),
  ),
  version: literal(docsManifestVersion),
});

function rawPagePath(contentRoot: string, absolutePath: string, prefix: string) {
  const segments = relative(contentRoot, absolutePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "")
    .split("/")
    .map(segment => segment.replace(/^\d+\./, ""));
  if (segments.at(-1) === "index") segments.pop();
  const route = [prefix, ...segments].filter(Boolean).join("/") || "index";
  return `${route}.md`;
}

function writeRawMarkdownArtifacts(docsRoot: string, outputDir: string) {
  const rawOutputDir = resolve(outputDir, "raw");
  const expectedPaths = new Set<string>();

  for (const [directory, prefix] of [["docs", "docs"], ["blog", "blog"], ["trust", ""]] as const) {
    const contentRoot = resolve(docsRoot, "content", directory);
    for (const absolutePath of listFiles(contentRoot, ".md")) {
      const destination = resolve(rawOutputDir, rawPagePath(contentRoot, absolutePath, prefix));
      expectedPaths.add(destination);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      writeFileSync(destination, toRawMarkdown(readFileSync(absolutePath, "utf8")));
    }
  }

  for (const existingPath of listFiles(rawOutputDir, ".md")) {
    if (!expectedPaths.has(existingPath)) unlinkSync(existingPath);
  }
}

function parseFrontmatter(source: string) {
  if (!source.startsWith("---\n")) {
    return {};
  }

  const endIndex = source.indexOf("\n---", 4);
  if (endIndex === -1) {
    return {};
  }

  const frontmatter = source.slice(4, endIndex).trim();
  const result: Record<string, unknown> = {};

  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key = "", value = ""] = match;
    result[key] = parseScalar(value);
  }

  return result;
}

function parseNavigationFile(sectionDir: string) {
  const navigationPath = resolve(sectionDir, ".navigation.yml");
  if (!existsSync(navigationPath)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const line of readFileSync(navigationPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key = "", value = ""] = match;
    result[key] = parseScalar(value);
  }

  return result;
}

function normalizePageId(relativeFile: string) {
  const withoutExtension = relativeFile.replace(/\.md$/, "");
  if (withoutExtension === "index") {
    return "index";
  }

  if (withoutExtension.endsWith("/index")) {
    return withoutExtension.slice(0, -"/index".length) || "index";
  }

  return withoutExtension;
}

function pagePath(sectionId: string, pageId: string) {
  return pageId === "index"
    ? `/docs/${sectionId}`
    : `/docs/${sectionId}/${pageId}`;
}

function pageTitleFromMeta(pageId: string, meta: Record<string, unknown>) {
  return String(meta["navigation.title"] || meta.title || titleCase(pageId === "index" ? "overview" : pageId));
}

function optionalString(value: unknown) {
  const result = safeParse(string(), value);
  return result.success ? result.output : null;
}

function optionalNumber(value: unknown) {
  const result = safeParse(number(), value);
  return result.success ? result.output : null;
}

function pageOrderFromMeta(meta: Record<string, unknown>) {
  const result = optionalNumber(meta["navigation.order"]);
  return result ?? Number.MAX_SAFE_INTEGER;
}

function collectPages(rootDir: string, sectionId: string) {
  return listFiles(rootDir, ".md").map((absolutePath) => {
    const relativeFile = relative(rootDir, absolutePath).replace(/\\/g, "/");
    const source = readFileSync(absolutePath, "utf8");
    const pageId = normalizePageId(relativeFile);
    const meta = parseFrontmatter(source);

    return {
      id: pageId,
      path: pagePath(sectionId, pageId),
      title: pageTitleFromMeta(pageId, meta),
      sourceTitle: optionalString(meta.title),
      description: optionalString(meta.description),
      icon: optionalString(meta.icon),
      group: optionalString(meta["navigation.group"]),
      lanes: parseDocsLanes(meta["navigation.lanes"]),
      navigation: meta.navigation !== false,
      order: pageOrderFromMeta(meta),
    };
  }).sort((left, right) => {
    if (left.id === "index") {
      return -1;
    }

    if (right.id === "index") {
      return 1;
    }

    if (left.order !== right.order) {
      return left.order - right.order;
    }

    return left.id.localeCompare(right.id);
  });
}

function collectRootPage(localDocsRoot: string) {
  const rootPath = resolve(localDocsRoot, "index.md");
  if (!existsSync(rootPath)) {
    return null;
  }

  const meta = parseFrontmatter(readFileSync(rootPath, "utf8"));
  return {
    id: "index",
    path: "/docs",
    title: pageTitleFromMeta("index", meta),
    sourceTitle: optionalString(meta.title),
    description: optionalString(meta.description),
    icon: optionalString(meta.icon),
    lanes: docsLanes,
    navigation: meta.navigation !== false,
    order: pageOrderFromMeta(meta),
  };
}

function createDocsSection(sectionId: string, rootDir: string, order: number) {
  const navigation = parseNavigationFile(rootDir);
  const lanes = parseDocsLanes(navigation.lanes) || [...docsLanes];
  const pages = collectPages(rootDir, sectionId).map(page => ({
    ...page,
    lanes: page.lanes || lanes,
  }));
  const overview = pages.find(page => page.id === "index");

  return {
    id: sectionId,
    path: pagePath(sectionId, "index"),
    title: optionalString(navigation.title) || overview?.sourceTitle || titleCase(sectionId),
    description: overview?.description || null,
    icon: optionalString(navigation.icon) || overview?.icon || null,
    lanes,
    order: optionalNumber(navigation.order) ?? order,
    pages,
  };
}

function collectSections(localDocsRoot: string) {
  if (!existsSync(localDocsRoot)) {
    return [];
  }

  return readdirSync(localDocsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry, index) => createDocsSection(entry.name, resolve(localDocsRoot, entry.name), index))
    .filter(section => section.pages.length > 0)
    .sort((left, right) => {
      return left.order - right.order || left.title.localeCompare(right.title);
    });
}

export function writeDocsArtifacts({ docsRoot, outputDir }: DocsArtifactOptions) {
  const localDocsRoot = resolve(docsRoot, "content", "docs");
  const rootPage = collectRootPage(localDocsRoot);
  const sections = collectSections(localDocsRoot);

  const manifest = {
    version: docsManifestVersion,
    rootPage,
    sections,
  };

  writeRawMarkdownArtifacts(docsRoot, outputDir);

  mkdirSync(outputDir, { recursive: true });

  const manifestSource = `export const docsManifest = ${JSON.stringify(manifest, null, 2)};\n\nexport default docsManifest;\n`;
  const manifestPath = resolve(outputDir, "docs-manifest.mjs");
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestSource) {
    const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, manifestSource);
      renameSync(temporaryPath, manifestPath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  return manifest;
}

export function readDocsArtifactsManifest(outputDir: string) {
  const manifestPath = resolve(outputDir, "docs-manifest.mjs");
  if (!existsSync(manifestPath)) {
    return null;
  }

  const source = readFileSync(manifestPath, "utf8");
  const prefix = "export const docsManifest = ";
  const suffix = ";\n\nexport default docsManifest;\n";

  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return null;
  }

  const manifest: unknown = JSON.parse(source.slice(prefix.length, -suffix.length));
  const result = safeParse(docsManifestSchema, manifest);
  return result.success ? result.output : null;
}

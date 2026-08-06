import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { listFiles, parseScalar, titleCase } from "./artifacts/common";
import { docsLanes, parseDocsLanes } from "./docs-lanes";

type DocsArtifactOptions = {
  docsRoot: string;
  outputDir: string;
};

const docsManifestVersion = 1;

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

function pageOrderFromMeta(meta: Record<string, unknown>) {
  return typeof meta["navigation.order"] === "number" ? meta["navigation.order"] : Number.MAX_SAFE_INTEGER;
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
      sourceTitle: typeof meta.title === "string" ? meta.title : null,
      description: typeof meta.description === "string" ? meta.description : null,
      icon: typeof meta.icon === "string" ? meta.icon : null,
      group: typeof meta["navigation.group"] === "string" ? meta["navigation.group"] : null,
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
    sourceTitle: typeof meta.title === "string" ? meta.title : null,
    description: typeof meta.description === "string" ? meta.description : null,
    icon: typeof meta.icon === "string" ? meta.icon : null,
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
    title: typeof navigation.title === "string" ? navigation.title : overview?.sourceTitle || titleCase(sectionId),
    description: overview?.description || null,
    icon: typeof navigation.icon === "string" ? navigation.icon : overview?.icon || null,
    lanes,
    order: typeof navigation.order === "number" ? navigation.order : order,
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

  mkdirSync(outputDir, { recursive: true });

  const manifestSource = `export const docsManifest = ${JSON.stringify(manifest, null, 2)};\n\nexport default docsManifest;\n`;
  const manifestPath = resolve(outputDir, "docs-manifest.mjs");
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestSource) {
    writeFileSync(manifestPath, manifestSource);
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

  const manifest = JSON.parse(source.slice(prefix.length, -suffix.length)) as Partial<ReturnType<typeof writeDocsArtifacts>>;
  return manifest.version === docsManifestVersion
    ? manifest as ReturnType<typeof writeDocsArtifacts>
    : null;
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix as pathPosix, relative, resolve } from "node:path";
import { listFiles, parseScalar, titleCase } from "./artifacts/common";
import { parsePackageExamples } from "./artifacts/examples";
import { usageModes } from "./runtime/utils/fw-variants";
import { defaultFramework, frameworks as frameworkIds, type Framework } from "./runtime/utils/frameworks";

type DocsArtifactOptions = {
  docsRoot: string;
  repoRoot: string;
  outputDir: string;
};

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

function pageTitleFromMeta(pageId: string, meta: Record<string, unknown>) {
  return String(meta["navigation.title"] || meta.title || titleCase(pageId === "index" ? "overview" : pageId));
}

function getSupportedFrameworks(meta: Record<string, unknown>) {
  const frameworks = Array.isArray(meta.frameworks)
    ? meta.frameworks
    : typeof meta.frameworks === "string"
      ? meta.frameworks.split(",").map(item => item.trim()).filter(Boolean)
      : null;

  return frameworks && frameworks.length
    ? frameworks.filter((framework): framework is Framework => frameworkIds.includes(framework as Framework))
    : [...frameworkIds];
}

function fwBlockMatchesFramework(meta: string | undefined, framework: Framework) {
  if (!meta) {
    return false;
  }

  const id = meta.match(/\bid\s*=\s*["']([^"']*)/)?.[1] || meta;

  return id
    .split(/[\s,]+/)
    .filter(Boolean)
    .some(item => {
      const token = item.replace(/^:/, "");
      return token === framework || token.startsWith(`${framework}:`);
    });
}

export function filterFwBlocksForFramework(source: string, framework: Framework) {
  const lines = source.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = line.match(/^\s*::fw(?:\{([^}]*)\})?\s*$/);

    if (!match) {
      output.push(line);
      continue;
    }

    const body: string[] = [];
    let closed = false;

    for (index++; index < lines.length; index++) {
      if (/^\s*::\s*$/.test(lines[index]!)) {
        closed = true;
        break;
      }

      body.push(lines[index]!);
    }

    if (!closed) {
      output.push(line, ...body);
      break;
    }

    if (fwBlockMatchesFramework(match[1], framework)) {
      output.push(...body);
    }
  }

  return output.join("\n");
}

function splitLinkTarget(target: string) {
  const suffixIndex = target.search(/[?#]/);

  return suffixIndex === -1
    ? { path: target, suffix: "" }
    : { path: target.slice(0, suffixIndex), suffix: target.slice(suffixIndex) };
}

function resolveFrameworkDocLink(framework: Framework, sectionId: string, relativeFile: string, target: string) {
  if (
    !target
    || target.startsWith("/")
    || target.startsWith("#")
    || /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return target;
  }

  const { path, suffix } = splitLinkTarget(target);
  if (!path.startsWith("./") && !path.startsWith("../")) {
    return target;
  }

  const sourceRouteFile = pathPosix.join(sectionId, relativeFile);
  const targetRouteFile = pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourceRouteFile), path));
  let pageId = targetRouteFile.replace(/\.md$/, "");

  if (pageId === "." || pageId === "index") {
    return `/docs/${framework}${suffix}`;
  }

  if (pageId.endsWith("/index")) {
    pageId = pageId.slice(0, -"/index".length);
  }

  return `/docs/${framework}/${pageId}${suffix}`;
}

export function rewriteFrameworkDocLinks(source: string, framework: Framework, sectionId: string, relativeFile: string) {
  return source
    .replace(/(!?\[[^\]\n]+\]\()([^)]+)(\))/g, (match: string, prefix: string, target: string, suffix: string) => {
      if (prefix.startsWith("![")) {
        return match;
      }

      return `${prefix}${resolveFrameworkDocLink(framework, sectionId, relativeFile, target)}${suffix}`;
    })
    .replace(/^(\s*to:\s*)(["']?)([^'"\n]+)\2\s*$/gm, (_match: string, prefix: string, quote: string, target: string) => {
      return `${prefix}${quote}${resolveFrameworkDocLink(framework, sectionId, relativeFile, target)}${quote}`;
    });
}

function collectPages(rootDir: string) {
  return listFiles(rootDir, ".md").map((absolutePath) => {
    const relativeFile = relative(rootDir, absolutePath).replace(/\\/g, "/");
    const source = readFileSync(absolutePath, "utf8");
    const pageId = normalizePageId(relativeFile);
    const meta = parseFrontmatter(source);

    return {
      relativeFile,
      pageId,
      source,
      title: pageTitleFromMeta(pageId, meta),
      sourceTitle: typeof meta.title === "string" ? meta.title : null,
      description: typeof meta.description === "string" ? meta.description : null,
      icon: typeof meta.icon === "string" ? meta.icon : null,
      group: typeof meta["navigation.group"] === "string" ? meta["navigation.group"] : null,
      order: typeof meta["navigation.order"] === "number" ? meta["navigation.order"] : Number.MAX_SAFE_INTEGER,
      frameworks: getSupportedFrameworks(meta),
    };
  }).sort((left, right) => {
    if (left.pageId === "index") {
      return -1;
    }

    if (right.pageId === "index") {
      return 1;
    }

    if (left.order !== right.order) {
      return left.order - right.order;
    }

    return left.pageId.localeCompare(right.pageId);
  });
}

function renderFrameworkPageContents(page: ReturnType<typeof collectPages>[number], framework: Framework, sectionId: string) {
  return rewriteFrameworkDocLinks(
    filterFwBlocksForFramework(page.source, framework),
    framework,
    sectionId,
    page.relativeFile,
  );
}

function addGeneratedPages(
  generatedPages: Array<{ filename: string; contents: string }>,
  pages: ReturnType<typeof collectPages>,
  sectionId: string,
) {
  for (const page of pages) {
    for (const framework of page.frameworks) {
      generatedPages.push({
        filename: `docs-content/${framework}/${sectionId}/${page.relativeFile}`,
        contents: renderFrameworkPageContents(page, framework, sectionId),
      });
    }
  }
}

function serializeSectionPages(pages: ReturnType<typeof collectPages>) {
  return pages.map(({ pageId, title, sourceTitle, description, icon, group, frameworks }) => ({
    id: pageId,
    title,
    sourceTitle,
    description,
    icon,
    group,
    frameworks,
  }));
}

function createDocsSection(
  sectionId: string,
  pages: ReturnType<typeof collectPages>,
  details: {
    source: "local" | "package";
    packageName: string | null;
    order: number;
    titleFallback: string;
  },
) {
  const overview = pages.find(page => page.pageId === "index");
  return {
    id: sectionId,
    title: overview?.sourceTitle || details.titleFallback,
    description: overview?.description || null,
    icon: overview?.icon || null,
    source: details.source,
    packageName: details.packageName,
    order: details.order,
    pages: serializeSectionPages(pages),
  };
}

export function writeDocsArtifacts({ docsRoot, repoRoot, outputDir }: DocsArtifactOptions) {
  const packagesRoot = resolve(repoRoot, "packages");
  const localDocsRoot = resolve(docsRoot, "content", "docs");
  const examples = parsePackageExamples(packagesRoot);
  const exampleByPackage = new Map(examples.map(example => [example.pkg, example]));
  const generatedPages: Array<{ filename: string; contents: string }> = [];

  const sections = [
    ...(existsSync(localDocsRoot)
      ? readdirSync(localDocsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map((entry, index) => {
          const sectionId = entry.name;
          const pages = collectPages(resolve(localDocsRoot, sectionId));
          addGeneratedPages(generatedPages, pages, sectionId);

          return createDocsSection(sectionId, pages, {
            source: "local",
            packageName: null,
            order: index,
            titleFallback: titleCase(sectionId),
          });
        })
      : []),
    ...readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(packageName => existsSync(resolve(packagesRoot, packageName, "docs")))
      .map((packageName) => {
        const example = exampleByPackage.get(packageName);
        const sectionId = example?.docsPath || packageName;
        const pages = collectPages(resolve(packagesRoot, packageName, "docs"));
        addGeneratedPages(generatedPages, pages, sectionId);

        return createDocsSection(sectionId, pages, {
          source: "package",
          packageName,
          order: example?.order ?? Number.MAX_SAFE_INTEGER,
          titleFallback: example?.label || titleCase(sectionId),
        });
      })
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)),
  ];

  const packageSections = sections
    .filter(s => s.source === "package")
    .map(s => ({ id: s.id, title: s.title, icon: s.icon }));

  const manifest = {
    frameworks: [...frameworkIds],
    defaultFramework,
    usageModes: [...usageModes],
    defaultMode: "dev",
    sections,
    packageSections,
    examples,
  };

  mkdirSync(outputDir, { recursive: true });
  const docsContentDir = resolve(outputDir, "docs-content");
  mkdirSync(docsContentDir, { recursive: true });

  const expectedPagePaths = new Set(generatedPages.map(page => resolve(outputDir, page.filename)));
  for (const existingPath of listFiles(docsContentDir, "")) {
    if (!expectedPagePaths.has(existingPath)) rmSync(existingPath, { force: true });
  }
  for (const page of generatedPages) {
    const absolutePath = resolve(outputDir, page.filename);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    if (!existsSync(absolutePath) || readFileSync(absolutePath, "utf8") !== page.contents) writeFileSync(absolutePath, page.contents);
  }

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

  return JSON.parse(source.slice(prefix.length, -suffix.length)) as ReturnType<typeof writeDocsArtifacts>;
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

const frameworkIds = ["vite", "nitro", "nuxt"] as const;
const usageModes = ["dev", "build"] as const;
const phaseOrder = ["configure", "define", "run"] as const;

type Framework = (typeof frameworkIds)[number];
type DocsArtifactOptions = {
  docsRoot: string;
  repoRoot: string;
  outputDir: string;
};

type PackageManifest = {
  name?: string;
  version?: string;
  [key: string]: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function titleCase(input: string) {
  return input
    .split(/[-/]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function listFiles(rootDir: string, extension: string): string[] {
  if (!existsSync(rootDir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const abs = join(rootDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...listFiles(abs, extension));
    else if (entry.isFile() && (!extension || abs.endsWith(extension))) files.push(abs);
  }
  return files.sort();
}

function parseScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  // Handle arrays: [a, b] or bare comma-separated values
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed.includes(",") ? trimmed : null;
  if (inner !== null)
    return inner.split(",").map(item => item.trim()).filter(Boolean).map(item => item.replace(/^['"]|['"]$/g, ""));
  return trimmed;
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

function splitUrlSuffix(target: string) {
  const suffixIndex = target.search(/[?#]/);
  return suffixIndex === -1
    ? { pathname: target, suffix: "" }
    : { pathname: target.slice(0, suffixIndex), suffix: target.slice(suffixIndex) };
}

function normalizeGeneratedDocLink(target: string, framework: Framework, sectionId: string, relativeFile: string) {
  if (!target.startsWith("./") && !target.startsWith("../")) return target;

  const currentDir = posix.dirname(posix.join(sectionId, relativeFile.replace(/\.md$/, "")));
  const { pathname, suffix } = splitUrlSuffix(target);
  let resolved = posix.normalize(posix.join(currentDir, pathname));

  if (resolved === ".") resolved = sectionId;
  if (resolved.endsWith("/index")) resolved = resolved.slice(0, -"/index".length);

  return `/docs/${framework}/${resolved}${suffix}`;
}

function rewriteGeneratedDocLinks(source: string, framework: Framework, sectionId: string, relativeFile: string) {
  return source
    .replace(/(!?\[[^\]]+\]\()((?:\.\.?\/)[^)]+)(\))/g, (match, prefix: string, target: string, suffix: string) => {
      if (prefix.startsWith("![")) return match;
      return `${prefix}${normalizeGeneratedDocLink(target, framework, sectionId, relativeFile)}${suffix}`;
    })
    .replace(/^(\s*to:\s*)(['"]?)(\.\.?\/[^'"\s]+)(\2)\s*$/gm, (_, prefix: string, quote: string, target: string) => {
      return `${prefix}${quote}${normalizeGeneratedDocLink(target, framework, sectionId, relativeFile)}${quote}`;
    });
}

function getPhasePriority(modeConfig: { phases: Partial<Record<typeof phaseOrder[number], string>>; supplementalFiles?: string[] }, path: string) {
  const index = phaseOrder.findIndex(phaseId => modeConfig.phases[phaseId] === path);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function sortExampleFiles(files: Array<{ path: string; code: string }>, modeConfig: { phases: Partial<Record<typeof phaseOrder[number], string>>; supplementalFiles?: string[] }) {
  const supplementalFileOrder = new Map((modeConfig.supplementalFiles || []).map((path, index) => [path, index]));
  const supplementalFiles = new Set(supplementalFileOrder.keys());

  return [...files].sort((left, right) => {
    const phaseA = getPhasePriority(modeConfig, left.path);
    const phaseB = getPhasePriority(modeConfig, right.path);
    if (phaseA !== phaseB) {
      return phaseA - phaseB;
    }

    const supplementalA = supplementalFiles.has(left.path) ? 0 : 1;
    const supplementalB = supplementalFiles.has(right.path) ? 0 : 1;
    if (supplementalA !== supplementalB) {
      return supplementalA - supplementalB;
    }

    if (supplementalA === 0 && supplementalB === 0) {
      return (supplementalFileOrder.get(left.path) ?? Number.POSITIVE_INFINITY)
        - (supplementalFileOrder.get(right.path) ?? Number.POSITIVE_INFINITY);
    }

    return left.path.localeCompare(right.path);
  });
}

function readWorkspaceCatalogVersions(repoRoot: string) {
  const workspaceConfig = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const versions = new Map<string, string>();
  const lines = workspaceConfig.split("\n");
  let inCatalog = false;

  for (const line of lines) {
    if (!inCatalog) {
      if (line.trim() === "catalog:") {
        inCatalog = true;
      }
      continue;
    }

    if (/^\S/.test(line)) {
      break;
    }

    const match = line.match(/^\s{2,}['"]?([^'":]+)['"]?:\s*(.+)$/);
    if (!match) {
      continue;
    }

    const [, name = "", version = ""] = match;
    versions.set(name, String(parseScalar(version)));
  }

  return versions;
}

function readWorkspacePackageVersions(packagesRoot: string) {
  const versions = new Map<string, string>();

  for (const packageName of readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const packageJsonPath = resolve(packagesRoot, packageName, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
      versions.set(packageJson.name, packageJson.version);
    }
  }

  return versions;
}

function normalizeExamplePackageJson(
  code: string,
  catalogVersions: Map<string, string>,
  workspacePackageVersions: Map<string, string>,
) {
  const packageJson = JSON.parse(code) as PackageManifest;

  if (packageJson.private === true) {
    delete packageJson.private;
  }

  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const deps = packageJson[field];
    if (!deps || typeof deps !== "object") {
      continue;
    }

    for (const [name, rawVersion] of Object.entries(deps as Record<string, unknown>)) {
      if (rawVersion === "catalog:") {
        const resolvedVersion = catalogVersions.get(name);
        if (resolvedVersion) {
          (deps as Record<string, unknown>)[name] = resolvedVersion;
        }
        continue;
      }

      if (rawVersion === "workspace:*") {
        const resolvedVersion = workspacePackageVersions.get(name);
        if (resolvedVersion) {
          (deps as Record<string, unknown>)[name] = resolvedVersion;
        }
      }
    }
  }

  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function parseExampleFiles(packagesRoot: string, repoRoot: string) {
  const result: Record<string, Record<Framework, Array<{ path: string; code: string }>>> = {};
  const catalogVersions = readWorkspaceCatalogVersions(repoRoot);
  const workspacePackageVersions = readWorkspacePackageVersions(packagesRoot);

  for (const packageName of readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    for (const framework of frameworkIds) {
      const frameworkRoot = resolve(packagesRoot, packageName, "examples", framework);
      if (!existsSync(frameworkRoot)) {
        continue;
      }

      const files = listFiles(frameworkRoot, "").map((absolutePath) => {
        const relativePath = relative(frameworkRoot, absolutePath).replace(/\\/g, "/");
        return {
          path: relativePath,
          code: relativePath === "package.json"
            ? normalizeExamplePackageJson(
                readFileSync(absolutePath, "utf8"),
                catalogVersions,
                workspacePackageVersions,
              ).trimEnd()
            : readFileSync(absolutePath, "utf8").trimEnd(),
        };
      }).filter((file) => {
        return ![
          "dist/",
          ".nuxt/",
          ".output/",
          ".nitro/",
          ".vercel/",
          ".netlify/",
          ".wrangler/",
          "node_modules/",
        ].some(prefix => file.path.startsWith(prefix));
      });

      result[packageName] ||= { vite: [], nitro: [], nuxt: [] };
      result[packageName][framework] = files;
    }
  }

  return result;
}

const frameworkConfigFiles: Record<Framework, string> = { nuxt: "nuxt.config.ts", nitro: "nitro.config.ts", vite: "vite.config.ts" };
const darkInvertProviders = new Set(["vercel", "netlify"]);

function normalizeProvider(raw: string | Record<string, unknown>) {
  const p = typeof raw === "string" ? { id: raw } : raw;
  const id = String(p.id);
  return {
    id,
    label: typeof p.label === "string" ? p.label : titleCase(id),
    icon: typeof p.icon === "string" ? p.icon : `i-logos-${id}-icon`,
    darkInvert: typeof p.darkInvert === "boolean" ? p.darkInvert : darkInvertProviders.has(id),
    ...(p.configOverride ? { configOverride: String(p.configOverride) } : {}),
    ...(p.envOverride ? { envOverride: String(p.envOverride) } : {}),
    ...(p.hiddenFiles ? { hiddenFiles: p.hiddenFiles as string[] } : {}),
  };
}

function normalizeFrameworks(manifest: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const framework of frameworkIds) {
    const fw = manifest.frameworks?.[framework];
    if (!fw) continue;
    const configFile = frameworkConfigFiles[framework];

    // Already in full format (has modes.dev.phases or modes.build.phases)
    if (fw.modes) {
      for (const mode of usageModes) {
        if (fw.modes[mode]?.phases && !fw.modes[mode].phases.configure)
          fw.modes[mode].phases.configure = configFile;
      }
      result[framework] = fw;
      continue;
    }

    // Flat format: { run, buildRun?, define?, buildDefine? }
    result[framework] = {
      modes: {
        dev: { phases: { configure: configFile, ...(fw.define ? { define: fw.define } : {}), ...(fw.run ? { run: fw.run } : {}) } },
        build: { phases: { configure: configFile, ...(fw.buildDefine || fw.define ? { define: fw.buildDefine || fw.define } : {}), ...(fw.buildRun || fw.run ? { run: fw.buildRun || fw.run } : {}) } },
      },
    };
  }
  return result;
}

function parsePackageExamples(packagesRoot: string) {
  const filesByPackage = parseExampleFiles(packagesRoot, resolve(packagesRoot, ".."));
  const manifests = listFiles(packagesRoot, "showcase.json");
  const examples: any[] = [];

  for (const manifestPath of manifests) {
    const packageName = manifestPath.match(/packages\/([^/]+)\/examples\/showcase\.json$/)?.[1];
    assert(packageName, `[showcase] Invalid manifest path ${manifestPath}`);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert(manifest.frameworks && typeof manifest.frameworks === "object", `[showcase] Missing frameworks in ${manifestPath}`);

    const label = typeof manifest.label === "string" ? manifest.label : titleCase(packageName);
    const docsPath = typeof manifest.docsPath === "string" ? manifest.docsPath : packageName;
    const providers = (Array.isArray(manifest.providers) ? manifest.providers : []).map(normalizeProvider);
    const frameworks = normalizeFrameworks(manifest);
    const packageFiles = filesByPackage[packageName] || { vite: [], nitro: [], nuxt: [] };

    for (const framework of frameworkIds) {
      const fileSet = new Set(packageFiles[framework].map(file => file.path));
      const frameworkConfig = frameworks[framework];
      assert(frameworkConfig?.modes, `[showcase] Missing ${framework} config in ${manifestPath}`);

      for (const mode of usageModes) {
        const modeConfig = frameworkConfig.modes[mode];
        assert(modeConfig?.phases, `[showcase] Missing ${framework}:${mode} phases in ${manifestPath}`);

        for (const phaseId of phaseOrder) {
          const filePath = modeConfig.phases[phaseId];
          if (!filePath) continue;
          assert(fileSet.has(filePath), `[showcase] Missing ${framework}:${mode}:${phaseId} file "${filePath}" for ${packageName}`);
          assert(filePath !== "env.example", `[showcase] env.example cannot be used as the ${framework}:${mode}:${phaseId} phase for ${packageName}`);
        }
      }
    }

    examples.push({
      pkg: packageName,
      label,
      docsPath,
      icon: typeof manifest.icon === "string" ? manifest.icon : null,
      defaultPhase: manifest.defaultPhase === "define" || manifest.defaultPhase === "run" ? manifest.defaultPhase : "configure",
      providers,
      order: manifest.order ?? Number.MAX_SAFE_INTEGER,
      frameworks,
      files: Object.fromEntries(
        frameworkIds.map((framework) => {
          const defaultMode = frameworks[framework].modes.dev || frameworks[framework].modes.build;
          return [framework, sortExampleFiles(packageFiles[framework], defaultMode)];
        }),
      ),
    });
  }

  return examples.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
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
          const overview = pages.find(page => page.pageId === "index");

          for (const page of pages) {
            for (const framework of page.frameworks) {
              const source = filterFwBlocksForFramework(page.source, framework);
              generatedPages.push({
                filename: `docs-content/${framework}/${sectionId}/${page.relativeFile}`,
                contents: rewriteGeneratedDocLinks(source, framework, sectionId, page.relativeFile),
              });
            }
          }

          return {
            id: sectionId,
            title: overview?.sourceTitle || titleCase(sectionId),
            description: overview?.description || null,
            icon: overview?.icon || null,
            source: "local",
            packageName: null,
            order: index,
            pages: pages.map(({ pageId, title, sourceTitle, description, icon, group, frameworks }) => ({
              id: pageId,
              title,
              sourceTitle,
              description,
              icon,
              group,
              frameworks,
            })),
          };
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
        const overview = pages.find(page => page.pageId === "index");

        for (const page of pages) {
          for (const framework of page.frameworks) {
            const source = filterFwBlocksForFramework(page.source, framework);
            generatedPages.push({
              filename: `docs-content/${framework}/${sectionId}/${page.relativeFile}`,
              contents: rewriteGeneratedDocLinks(source, framework, sectionId, page.relativeFile),
            });
          }
        }

        return {
          id: sectionId,
          title: overview?.sourceTitle || example?.label || titleCase(sectionId),
          description: overview?.description || null,
          icon: overview?.icon || null,
          source: "package",
          packageName,
          order: example?.order ?? Number.MAX_SAFE_INTEGER,
          pages: pages.map(({ pageId, title, sourceTitle, description, icon, group, frameworks }) => ({
            id: pageId,
            title,
            sourceTitle,
            description,
            icon,
            group,
            frameworks,
          })),
        };
      })
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)),
  ];

  const packageSections = sections
    .filter(s => s.source === "package")
    .map(s => ({ id: s.id, title: s.title, icon: s.icon }));

  const manifest = {
    frameworks: [...frameworkIds],
    defaultFramework: "nuxt",
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

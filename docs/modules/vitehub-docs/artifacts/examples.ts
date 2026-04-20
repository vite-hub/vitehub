import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { assert, listFiles, listPackageNames, parseScalar, titleCase } from "./common";
import { usageModes } from "../runtime/utils/fw-variants";
import { frameworks as frameworkIds, type Framework } from "../runtime/utils/frameworks";
import { getFrameworkConfigPath, showcasePhaseIds, sortShowcaseFiles } from "../shared/showcase";

type PackageManifest = {
  name?: string;
  version?: string;
  [key: string]: unknown;
};

type ExampleFile = {
  path: string;
  code: string;
};

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

  for (const packageName of listPackageNames(packagesRoot)) {
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

function resolveDependencyVersion(
  name: string,
  rawVersion: unknown,
  catalogVersions: Map<string, string>,
  workspacePackageVersions: Map<string, string>,
) {
  if (rawVersion === "catalog:") {
    return catalogVersions.get(name);
  }

  if (rawVersion === "workspace:*") {
    return workspacePackageVersions.get(name);
  }

  return null;
}

function normalizeDependencyMap(
  deps: unknown,
  catalogVersions: Map<string, string>,
  workspacePackageVersions: Map<string, string>,
) {
  if (!deps || typeof deps !== "object") {
    return;
  }

  for (const [name, rawVersion] of Object.entries(deps as Record<string, unknown>)) {
    const resolvedVersion = resolveDependencyVersion(name, rawVersion, catalogVersions, workspacePackageVersions);
    if (resolvedVersion) {
      (deps as Record<string, unknown>)[name] = resolvedVersion;
    }
  }
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
    normalizeDependencyMap(packageJson[field], catalogVersions, workspacePackageVersions);
  }

  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function readExampleFile(
  frameworkRoot: string,
  absolutePath: string,
  catalogVersions: Map<string, string>,
  workspacePackageVersions: Map<string, string>,
) {
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
}

function isVisibleExampleFile(file: ExampleFile) {
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
}

function parseExampleFiles(packagesRoot: string, repoRoot: string) {
  const result: Record<string, Record<Framework, ExampleFile[]>> = {};
  const catalogVersions = readWorkspaceCatalogVersions(repoRoot);
  const workspacePackageVersions = readWorkspacePackageVersions(packagesRoot);

  for (const packageName of listPackageNames(packagesRoot)) {
    for (const framework of frameworkIds) {
      const frameworkRoot = resolve(packagesRoot, packageName, "examples", framework);
      if (!existsSync(frameworkRoot)) {
        continue;
      }

      const files = listFiles(frameworkRoot, "")
        .map(absolutePath => readExampleFile(frameworkRoot, absolutePath, catalogVersions, workspacePackageVersions))
        .filter(isVisibleExampleFile);

      result[packageName] ||= { vite: [], nitro: [], nuxt: [] };
      result[packageName][framework] = files;
    }
  }

  return result;
}

const darkInvertProviders = new Set(["vercel", "netlify"]);

function normalizeProvider(raw: string | Record<string, unknown>) {
  const provider = typeof raw === "string" ? { id: raw } : raw;
  const id = String(provider.id);

  return {
    id,
    label: typeof provider.label === "string" ? provider.label : titleCase(id),
    icon: typeof provider.icon === "string" ? provider.icon : `i-logos-${id}-icon`,
    darkInvert: typeof provider.darkInvert === "boolean" ? provider.darkInvert : darkInvertProviders.has(id),
    ...(provider.configOverride ? { configOverride: String(provider.configOverride) } : {}),
    ...(provider.envOverride ? { envOverride: String(provider.envOverride) } : {}),
    ...(provider.hiddenFiles ? { hiddenFiles: provider.hiddenFiles as string[] } : {}),
  };
}

function normalizeModePhases(modeConfig: Record<string, any> | undefined, configurePath: string) {
  if (!modeConfig?.phases) {
    return modeConfig;
  }

  return {
    ...modeConfig,
    phases: {
      ...modeConfig.phases,
      configure: modeConfig.phases.configure || configurePath,
    },
  };
}

function normalizeConfiguredModes(frameworkConfig: Record<string, any>, configurePath: string) {
  return Object.fromEntries(
    usageModes.map(mode => [mode, normalizeModePhases(frameworkConfig.modes[mode], configurePath)]),
  );
}

function normalizeFlatModes(frameworkConfig: Record<string, any>, configurePath: string) {
  return {
    dev: {
      phases: {
        configure: configurePath,
        ...(frameworkConfig.define ? { define: frameworkConfig.define } : {}),
        ...(frameworkConfig.run ? { run: frameworkConfig.run } : {}),
      },
    },
    build: {
      phases: {
        configure: configurePath,
        ...(frameworkConfig.buildDefine || frameworkConfig.define ? { define: frameworkConfig.buildDefine || frameworkConfig.define } : {}),
        ...(frameworkConfig.buildRun || frameworkConfig.run ? { run: frameworkConfig.buildRun || frameworkConfig.run } : {}),
      },
    },
  };
}

function normalizeFrameworks(manifest: Record<string, any>) {
  const result: Record<string, any> = {};

  for (const framework of frameworkIds) {
    const frameworkConfig = manifest.frameworks?.[framework];
    if (!frameworkConfig) {
      continue;
    }

    const configurePath = getFrameworkConfigPath(framework);
    if (frameworkConfig.modes) {
      result[framework] = {
        ...frameworkConfig,
        modes: normalizeConfiguredModes(frameworkConfig, configurePath),
      };
      continue;
    }

    result[framework] = {
      modes: normalizeFlatModes(frameworkConfig, configurePath),
    };
  }

  return result;
}

function assertPhaseFilesExist(
  packageName: string,
  manifestPath: string,
  frameworks: Record<string, any>,
  packageFiles: Record<Framework, ExampleFile[]>,
) {
  for (const framework of frameworkIds) {
    const fileSet = new Set(packageFiles[framework].map(file => file.path));
    const frameworkConfig = frameworks[framework];
    assert(frameworkConfig?.modes, `[showcase] Missing ${framework} config in ${manifestPath}`);

    for (const mode of usageModes) {
      const modeConfig = frameworkConfig.modes[mode];
      assert(modeConfig?.phases, `[showcase] Missing ${framework}:${mode} phases in ${manifestPath}`);

      for (const phaseId of showcasePhaseIds) {
        const filePath = modeConfig.phases[phaseId];
        if (!filePath) {
          continue;
        }

        assert(fileSet.has(filePath), `[showcase] Missing ${framework}:${mode}:${phaseId} file "${filePath}" for ${packageName}`);
        assert(filePath !== "env.example", `[showcase] env.example cannot be used as the ${framework}:${mode}:${phaseId} phase for ${packageName}`);
      }
    }
  }
}

export function parsePackageExamples(packagesRoot: string, repoRoot = resolve(packagesRoot, "..")) {
  const filesByPackage = parseExampleFiles(packagesRoot, repoRoot);
  const manifests = listFiles(packagesRoot, "showcase.json");
  const examples: any[] = [];

  for (const manifestPath of manifests) {
    const relativeManifestPath = relative(packagesRoot, manifestPath).replace(/\\/g, "/");
    const packageName = relativeManifestPath.match(/^([^/]+)\/examples\/showcase\.json$/)?.[1];
    assert(packageName, `[showcase] Invalid manifest path ${manifestPath}`);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert(manifest.frameworks && typeof manifest.frameworks === "object", `[showcase] Missing frameworks in ${manifestPath}`);

    const label = typeof manifest.label === "string" ? manifest.label : titleCase(packageName);
    const docsPath = typeof manifest.docsPath === "string" ? manifest.docsPath : packageName;
    const providers = (Array.isArray(manifest.providers) ? manifest.providers : []).map(normalizeProvider);
    const frameworks = normalizeFrameworks(manifest);
    const packageFiles = filesByPackage[packageName] || { vite: [], nitro: [], nuxt: [] };
    assertPhaseFilesExist(packageName, manifestPath, frameworks, packageFiles);

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
          return [framework, sortShowcaseFiles(packageFiles[framework], defaultMode)];
        }),
      ),
    });
  }

  return examples.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

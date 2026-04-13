import { docsManifest, type DocsExample } from "./docs";
import { defaultUsageMode, type UsageMode } from "./fw-variants";
import type { Framework } from "./frameworks";

export type ShowcaseExample = DocsExample;
export type ExampleFile = ShowcaseExample["files"][Framework][number];
export type ShowcaseFrameworkConfig = ShowcaseExample["frameworks"][Framework];
export type ShowcaseModeConfig = ShowcaseFrameworkConfig["modes"][UsageMode];
export type ShowcaseProvider = NonNullable<ShowcaseExample["providers"]>[number];
export const showcasePhaseIds = ["configure", "define", "run"] as const;
export type ShowcasePhaseId = (typeof showcasePhaseIds)[number];

const extensionToLanguage = new Map<string, string>([
  ["ts", "ts"],
  ["tsx", "tsx"],
  ["js", "js"],
  ["jsx", "jsx"],
  ["json", "json"],
  ["md", "md"],
  ["mjs", "js"],
  ["cjs", "js"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["env", "bash"],
]);

function getPhasePriority(modeConfig: ShowcaseModeConfig, path: string) {
  const index = showcasePhaseIds.findIndex(phaseId => modeConfig.phases[phaseId] === path);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

export function getFrameworkConfigPath(framework: Framework) {
  if (framework === "nuxt") {
    return "nuxt.config.ts";
  }

  if (framework === "nitro") {
    return "nitro.config.ts";
  }

  return "vite.config.ts";
}

export function generateFrameworkConfig(framework: Framework, pkg: string, configOverride?: string | null) {
  if (!configOverride) {
    return null;
  }

  const modulePath = `@vitehub/${pkg}/${framework}`;
  if (framework === "nuxt") {
    return `export default defineNuxtConfig({\n  modules: ['${modulePath}'],\n${configOverride}\n})`;
  }

  if (framework === "nitro") {
    return `import { defineNitroConfig } from 'nitro/config'\n\nexport default defineNitroConfig({\n  modules: ['${modulePath}'],\n${configOverride}\n})`;
  }

  const fnName = `hub${pkg[0]!.toUpperCase()}${pkg.slice(1)}`;
  return `import { defineConfig } from 'vite'\nimport { ${fnName} } from '${modulePath}'\n\nexport default defineConfig({\n  plugins: [${fnName}()],\n${configOverride}\n})`;
}

export function getCodeLanguage(path: string) {
  if (path === "env.example" || path.endsWith(".env") || path.endsWith(".example")) {
    return "bash";
  }

  const extension = path.split(".").pop()?.toLowerCase();
  return extensionToLanguage.get(extension || "") || "txt";
}

export function getShowcaseExamples() {
  return docsManifest.examples;
}

export function getShowcaseModeConfig(example: ShowcaseExample, framework: Framework, mode: UsageMode = defaultUsageMode) {
  return example.frameworks[framework].modes[mode];
}

export function getShowcasePhasePaths(example: ShowcaseExample, framework: Framework, mode: UsageMode = defaultUsageMode) {
  return getShowcaseModeConfig(example, framework, mode).phases;
}

function isUsageMode(value: string | undefined): value is UsageMode {
  return value === "dev" || value === "build";
}

export function getShowcaseFiles(
  example: ShowcaseExample,
  framework: Framework,
  modeOrProviderId: UsageMode | string = defaultUsageMode,
  maybeProviderId?: string,
) {
  const mode = isUsageMode(modeOrProviderId) ? modeOrProviderId : defaultUsageMode;
  const providerId = isUsageMode(modeOrProviderId) ? maybeProviderId : modeOrProviderId;
  const modeConfig = getShowcaseModeConfig(example, framework, mode);
  const supplementalFiles = new Set(modeConfig.supplementalFiles || []);
  const provider = example.providers?.find(item => item.id === providerId);

  let files = example.files[framework].map((file) => {
    const configurePath = modeConfig.phases.configure || getFrameworkConfigPath(framework);

    if (provider?.configOverride && file.path === configurePath) {
      return {
        ...file,
        code: generateFrameworkConfig(framework, example.pkg, provider.configOverride) || file.code,
      };
    }

    if (provider?.envOverride && file.path === "env.example") {
      return {
        ...file,
        code: provider.envOverride,
      };
    }

    return file;
  });

  if (provider?.hiddenFiles?.length) {
    const hiddenFiles = new Set(provider.hiddenFiles);
    files = files.filter(file => !hiddenFiles.has(file.path));
  }

  if (provider?.envOverride && !files.some(file => file.path === "env.example")) {
    files = [...files, { path: "env.example", code: provider.envOverride }];
  }

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

    const envA = left.path === "env.example" ? 1 : 0;
    const envB = right.path === "env.example" ? 1 : 0;
    if (envA !== envB) {
      return envA - envB;
    }

    return left.path.localeCompare(right.path);
  });
}

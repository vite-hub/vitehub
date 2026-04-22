import { docsManifest, type DocsExample } from "./docs";
import { defaultUsageMode, type UsageMode } from "./fw-variants";
import { frameworks, type Framework } from "./frameworks";
import {
  generateFrameworkConfig,
  getFrameworkConfigPath,
  sortShowcaseFiles,
} from "../../shared/showcase";
export { showcasePhaseIds } from "../../shared/showcase";
export type { ShowcasePhaseId } from "../../shared/showcase";

type ShowcaseExample = DocsExample;
export type ExampleFile = { path: string; code: string };
type ShowcaseFrameworkConfig = NonNullable<ShowcaseExample["frameworks"][Framework]>;
type ShowcaseModeConfig = ShowcaseFrameworkConfig["modes"][UsageMode];
type ShowcaseProvider = NonNullable<ShowcaseExample["providers"]>[number];

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

export function getSupportedShowcaseFrameworks(example: ShowcaseExample) {
  return frameworks.filter((framework): framework is Framework => Boolean(example.frameworks[framework] && example.files[framework]?.length));
}

export function resolveShowcaseFramework(example: ShowcaseExample, framework: Framework) {
  const supportedFrameworks = getSupportedShowcaseFrameworks(example);
  return supportedFrameworks.includes(framework) ? framework : supportedFrameworks[0] || framework;
}

function getShowcaseModeConfig(example: ShowcaseExample, framework: Framework, mode: UsageMode = defaultUsageMode) {
  const resolvedFramework = resolveShowcaseFramework(example, framework);
  return example.frameworks[resolvedFramework]?.modes[mode];
}

export function getShowcasePhasePaths(example: ShowcaseExample, framework: Framework, mode: UsageMode = defaultUsageMode) {
  return getShowcaseModeConfig(example, framework, mode)?.phases || {};
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
  const resolvedFramework = resolveShowcaseFramework(example, framework);
  const modeConfig = getShowcaseModeConfig(example, framework, mode);
  if (!modeConfig) {
    return [];
  }
  const excludedFiles = modeConfig.excludedFiles || [];
  const provider = example.providers?.find(item => item.id === providerId);

  let files = (example.files[resolvedFramework] || []).map((file) => {
    const configurePath = modeConfig.phases.configure || getFrameworkConfigPath(resolvedFramework);

    if (provider?.configOverride && file.path === configurePath) {
      return {
        ...file,
        code: generateFrameworkConfig(resolvedFramework, example.pkg, provider.configOverride) || file.code,
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

  if (excludedFiles.length) {
    files = files.filter((file) => {
      return !excludedFiles.some(pattern => pattern.endsWith("/")
        ? file.path.startsWith(pattern)
        : file.path === pattern);
    });
  }

  if (provider?.envOverride && !files.some(file => file.path === "env.example")) {
    files = [...files, { path: "env.example", code: provider.envOverride }];
  }

  return sortShowcaseFiles(files, modeConfig, { sortEnvExampleLast: true });
}

import { docsManifest, type DocsExample } from "./docs";
import { defaultUsageMode, type UsageMode } from "./fw-variants";
import type { Framework } from "./frameworks";
import {
  generateFrameworkConfig,
  getFrameworkConfigPath,
  sortShowcaseFiles,
} from "../../shared/showcase";
export { showcasePhaseIds } from "../../shared/showcase";
export type { ShowcasePhaseId } from "../../shared/showcase";

type ShowcaseExample = DocsExample;
export type ExampleFile = ShowcaseExample["files"][Framework][number];
type ShowcaseFrameworkConfig = ShowcaseExample["frameworks"][Framework];
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

function getShowcaseModeConfig(example: ShowcaseExample, framework: Framework, mode: UsageMode = defaultUsageMode) {
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
  const excludedFiles = modeConfig.excludedFiles || [];
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

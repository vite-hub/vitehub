import type { Framework } from "../runtime/utils/frameworks";

export const showcasePhaseIds = ["configure", "define", "run"] as const;
export type ShowcasePhaseId = (typeof showcasePhaseIds)[number];

type ShowcaseModeConfigLike = {
  phases: Partial<Record<ShowcasePhaseId, string>>;
  supplementalFiles?: string[];
};

function getPhasePriority(modeConfig: ShowcaseModeConfigLike, path: string) {
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

export function sortShowcaseFiles<T extends { path: string }>(
  files: T[],
  modeConfig: ShowcaseModeConfigLike,
  options: { sortEnvExampleLast?: boolean } = {},
) {
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

    if (options.sortEnvExampleLast) {
      const envA = left.path === "env.example" ? 1 : 0;
      const envB = right.path === "env.example" ? 1 : 0;
      if (envA !== envB) {
        return envA - envB;
      }
    }

    return left.path.localeCompare(right.path);
  });
}

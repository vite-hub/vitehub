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
  return "vite.config.ts";
}

export function generateFrameworkConfig(configOverride?: string | null, serverEntry?: string) {
  const importNames = configOverride?.includes("env(") ? "env, vitehub" : "vitehub";
  const imports = `${serverEntry ? "import { resolve } from 'node:path'\n" : ""}import { defineConfig } from 'vite'\nimport { ${importNames} } from '@vite-hub/vite'`;
  const serverConfig = serverEntry
    ? `  appType: 'custom',\n  build: {\n    rollupOptions: {\n      input: resolve(import.meta.dirname, '${serverEntry}'),\n    },\n  },`
    : "";
  const lines = [serverConfig, "  plugins: [vitehub()],", configOverride?.trimEnd()].filter(Boolean).join("\n");
  return `${imports}\n\nexport default defineConfig({\n${lines}\n})`;
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

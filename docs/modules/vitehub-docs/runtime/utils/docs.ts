import docsManifestRaw from "#vitehub-docs-manifest";
import type { Framework } from "./frameworks";
import type { UsageMode } from "./showcase-modes";

export type DocsPage = {
  id: string;
  path: string;
  title: string;
  sourceTitle: string | null;
  description: string | null;
  icon: string | null;
  group?: string | null;
  navigation: boolean;
  order: number;
};

type DocsSection = {
  id: string;
  path: string;
  title: string;
  description: string | null;
  icon: string | null;
  order: number;
  pages: DocsPage[];
};

type DocsExampleMode = {
  phases: Partial<Record<"configure" | "define" | "run", string>>;
  supplementalFiles?: string[];
  excludedFiles?: string[];
};

type DocsExampleProvider = {
  id: string;
  label: string;
  icon: string;
  darkInvert?: boolean;
  configOverride?: string;
  configOverrides?: Partial<Record<Framework, string>>;
  envOverride?: string;
  hiddenFiles?: string[];
};

export type DocsExample = {
  pkg: string;
  label: string;
  docsPath: string;
  icon?: string | null;
  defaultPhase?: "configure" | "define" | "run";
  providers?: DocsExampleProvider[];
  order: number;
  frameworks: Partial<Record<Framework, { modes: Record<UsageMode, DocsExampleMode> }>>;
  files: Partial<Record<Framework, Array<{ path: string; code: string }>>>;
};

type DocsManifest = {
  rootPage: DocsPage | null;
  sections: DocsSection[];
  examples: DocsExample[];
};

export const docsManifest = docsManifestRaw as DocsManifest;

export function normalizeDocsPath(path?: string | null) {
  if (!path || path === "/docs/") return "/docs";
  return path.replace(/\/+$/, "") || "/docs";
}

export function getDocsPageByPath(path: string) {
  const normalizedPath = normalizeDocsPath(path);

  if (normalizedPath === "/docs") {
    return docsManifest.rootPage;
  }

  for (const section of docsManifest.sections) {
    const page = section.pages.find(page => normalizeDocsPath(page.path) === normalizedPath);
    if (page) {
      return page;
    }
  }

  return null;
}

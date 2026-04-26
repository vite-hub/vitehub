import docsManifestRaw from "#vitehub-docs-manifest";
import type { UsageMode } from "./fw-variants";
import type { Framework } from "./frameworks";

export type DocsPage = {
  id: string;
  title: string;
  sourceTitle: string | null;
  description: string | null;
  icon: string | null;
  group: string | null;
  frameworks: Framework[];
};

export type DocsSection = {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  source: "local" | "package";
  packageName: string | null;
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

type PackageSectionMeta = {
  id: string;
  title: string;
  icon: string | null;
};

type DocsManifest = {
  frameworks: Framework[];
  defaultFramework: Framework;
  usageModes: UsageMode[];
  defaultMode: UsageMode;
  sections: DocsSection[];
  packageSections: PackageSectionMeta[];
  examples: DocsExample[];
};

export const docsManifest = docsManifestRaw as DocsManifest;

export function getDocsPath(sectionId: string, framework: Framework, pageId = "index") {
  return pageId === "index"
    ? `/docs/${framework}/${sectionId}`
    : `/docs/${framework}/${sectionId}/${pageId}`;
}

export function getDocsPathMeta(path: string) {
  const parts = path.split("/").filter(Boolean);

  if (parts[0] !== "docs" || parts.length < 3) {
    return null;
  }

  const framework = parts[1];
  if (framework !== "vite" && framework !== "nitro" && framework !== "nuxt") {
    return null;
  }

  return {
    framework,
    section: parts[2] || "",
    page: parts.slice(3).join("/") || "index",
  };
}

function getDocsSection(sectionId: string) {
  return docsManifest.sections.find(section => section.id === sectionId) || null;
}

export function getDocsPage(sectionId: string, pageId = "index") {
  return getDocsSection(sectionId)?.pages.find(page => page.id === pageId) || null;
}

export function isDocsSectionSupported(sectionId: string, framework: Framework) {
  const section = getDocsSection(sectionId);

  if (!section) {
    return false;
  }

  return section.pages.some(page => page.frameworks.includes(framework));
}

export function isDocsPageSupported(sectionId: string, pageId: string, framework: Framework) {
  const page = getDocsPage(sectionId, pageId);

  if (!page) {
    return false;
  }

  return !page.frameworks || page.frameworks.includes(framework);
}

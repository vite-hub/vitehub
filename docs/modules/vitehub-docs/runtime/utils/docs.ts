import docsManifestRaw from "#vitehub-docs-manifest";

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

type DocsManifest = {
  rootPage: DocsPage | null;
  sections: DocsSection[];
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

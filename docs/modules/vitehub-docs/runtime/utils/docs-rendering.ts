import {
  getDocsPageByPath,
  normalizeDocsPath,
  type DocsPage,
} from "./docs";

type ContentPageInput = {
  path?: unknown;
  title?: unknown;
  description?: string | null;
  seo?: { title?: string; description?: string };
  meta?: Record<string, unknown> | null;
};

export type DocsPageFallback = {
  title: string;
  sourceTitle: string | null;
  description: string | null;
};

export type DocsPageState<T extends ContentPageInput> = T & {
  path: string;
  title: string;
  description: string;
  seo: { title: string; description: string };
  data: Record<string, unknown>;
};

type DocsResolvedRoute = {
  page: DocsPage | null;
  sourcePath: string;
};

export function resolveDocsRoute(path: string): DocsResolvedRoute {
  const sourcePath = normalizeDocsPath(path);
  const page = getDocsPageByPath(sourcePath);

  return {
    page,
    sourcePath,
  };
}

export function getDocsPageFallback(page: DocsPage): DocsPageFallback {
  return {
    title: page.title,
    sourceTitle: page.sourceTitle,
    description: page.description,
  };
}

export function createDocsPageState<T extends ContentPageInput>(
  doc: T | null | undefined,
  sourcePath: string,
  fallback: DocsPageFallback,
) {
  if (!doc) return null;

  const title = String(doc.title || fallback.sourceTitle || fallback.title);
  const description = doc.description || fallback.description || "";

  return {
    ...doc,
    path: sourcePath,
    title,
    description,
    seo: {
      title: doc.seo?.title || title,
      description: doc.seo?.description || description,
    },
    data: doc.meta || {},
  } satisfies DocsPageState<T>;
}

export function renderDocsPage<T extends ContentPageInput>(
  doc: T | null | undefined,
  sourcePath: string,
  fallback: DocsPageFallback,
) {
  return createDocsPageState(doc, sourcePath, fallback);
}

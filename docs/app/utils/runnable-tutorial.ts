export const tutorialRoute = "/learn";

/** Runnable tutorials: `/learn` and the pages under it. */
export function isIsolatedTutorialPath(path: string): boolean {
  return path === tutorialRoute || path.startsWith(`${tutorialRoute}/`);
}

// The lesson helpers ship with @vite-hub/docs, which renders `layout: learn` pages with them.
export { frameworkNodes, parseCurl, requestScript, splitTutorialDocument, type TutorialRequest } from "@vite-hub/docs/runnable";

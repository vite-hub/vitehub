export const tutorialRoute = "/learn";

/** Runnable tutorials: `/learn` and the `layout: learn` pages under it. */
export function isIsolatedTutorialPath(path: string): boolean {
  return path === tutorialRoute || path.startsWith(`${tutorialRoute}/`);
}

// Shared by the build and the browser, so this file imports nothing from Node.

/** Text files of an app, keyed by a relative path such as `server/api/greet.post.ts`. */
export type TutorialFiles = Record<string, string>;

export interface RunnableTutorialStep {
  /** The `::tutorial-step` title. */
  title: string;
  /** The files that this step writes, with their final contents from the fixture. */
  files: TutorialFiles;
}

/** What the workspace of one tutorial mounts, built from its lesson page and its fixture. */
export interface RunnableTutorialData {
  slug: string;
  /** The docs page that holds the lesson prose. */
  page: string;
  title: string;
  description: string;
  /** The files before step 1: the app that Installation creates, with the fixture's dependencies. */
  files: TutorialFiles;
  steps: RunnableTutorialStep[];
}

/** The files at the start of step `index` (from 0), or at its end with `solution`. Each step builds on the one before. */
export function tutorialStepFiles(tutorial: Pick<RunnableTutorialData, "files" | "steps">, index: number, state: "start" | "solution"): TutorialFiles {
  const last = state === "solution" ? index : index - 1;
  const files = { ...tutorial.files };
  for (let step = 0; step <= last && step < tutorial.steps.length; step++) Object.assign(files, tutorial.steps[step]!.files);
  return files;
}

/** Loads a lesson state, removing absent tutorial files while keeping unrelated reader additions. */
export function tutorialWorkspaceFiles(tutorial: Pick<RunnableTutorialData, "files" | "steps">, current: TutorialFiles, target: TutorialFiles): TutorialFiles {
  const owned = new Set([...Object.keys(tutorial.files), ...tutorial.steps.flatMap(step => Object.keys(step.files))]);
  const next = { ...current };
  for (const path of owned) {
    if (!(path in target)) delete next[path];
  }
  return Object.assign(next, target);
}

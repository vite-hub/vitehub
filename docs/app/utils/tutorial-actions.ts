import type { InjectionKey } from "vue";

/** What a lesson code block can ask of the workspace beside it. */
export interface TutorialActions {
  /** Whether the reader can open the workspace on this device and browser. */
  available: boolean;
  /** Whether a request can run now: after the install, while the dev server runs. */
  running: boolean;
  /** Paths of the app, for "Show in editor". */
  paths: readonly string[];
  show: (path: string) => void;
  /** Runs a lesson command in the workspace and returns its output. */
  run: (command: string) => Promise<string>;
}

export const tutorialActionsKey: InjectionKey<TutorialActions> = Symbol("tutorial-actions");

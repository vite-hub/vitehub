import { motionEffects } from "./effects/index.ts";
import { installMotion as installMotionEffects } from "./layer.ts";
import type { MotionRoot } from "./layer.ts";

/**
 * Starts the motion layer with every built-in effect: press, toggle, select, drag, and appear motion for every element
 * by its role, in `root`: the document by default, a shadow root, or an element and everything in it. `createViteHubUI()`
 * and the Nuxt module call it for the document. A surface with its own bundle, such as the page pill, takes
 * `installMotion` from `@vite-hub/ui/motion/core` instead and lists the effects it runs, so the others stay out of its
 * bundle.
 *
 * It is safe to call more than once. Returns a function that stops this install. On the server it does nothing.
 */
export function installMotion(root?: MotionRoot): () => void {
  if (typeof document === "undefined") return () => {};
  return installMotionEffects(root ?? document, { effects: motionEffects });
}

// The motion layer of docs/design/motion.md, with no Vue, so plain TypeScript surfaces such as the page pill use it too.
// It is `@vite-hub/ui/motion/core`, where `installMotion` runs every built-in effect.
export * from "./motion-core.ts";
export { installMotion } from "./motion/install.ts";

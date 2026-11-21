// The motion layer of docs/design/motion.md, with no Vue, so plain TypeScript surfaces such as the page pill use it too.
// Unlike `@vite-hub/ui/motion/core`, this entry installs every built-in effect by default.
export * from "./motion-core.ts";
export { installMotion } from "./motion/install.ts";

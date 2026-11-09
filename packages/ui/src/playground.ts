// Playground helpers with no UI: share links and zips. They run in browsers and in Node, so a build can write
// playground links and starter zips too.
export { isProjectPath } from "./playground/paths.ts";
export {
  decodePlaygroundLink,
  encodePlaygroundLink,
  playgroundHashKey,
  playgroundLinkLimit,
  playgroundUrl,
  readPlaygroundHash,
  type PlaygroundFiles,
  type PlaygroundState,
  type PlaygroundTemplate,
} from "./playground/share.ts";
export { downloadZip, zipFiles } from "./playground/zip.ts";

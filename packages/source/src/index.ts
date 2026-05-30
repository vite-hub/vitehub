export { defineSource, defineSources } from "./core/define.ts"
export {
  clearSources,
  getRegisteredSource,
  registerSource,
  registerSources,
  useSource,
} from "./core/registry.ts"
export type * from "./core/types.ts"
export {
  SourceNotFoundError,
  SourcePathError,
  SourceError,
} from "./core/errors.ts"
export {
  custom,
  file,
  github,
  glob,
  markdown,
} from "./sources/index.ts"
export * as source from "./sources/index.ts"
export type {
  FileSourceOptions,
  GitHubSourceOptions,
  GlobSourceOptions,
} from "./sources/index.ts"

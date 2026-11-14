import { pathToFileURL } from "node:url"

/** Where the generated Nitro plugin leaves the loader of `server/skills.ts`, for the `served-skills.*` operations. */
export const servedSkillsRegistryKey = "vitehub.skills.entry"

/**
 * The Nitro plugin that hands the operations a loader of the app's `server/skills.ts`. The module loads on the first
 * operation call, not when the server starts.
 */
export function renderServedSkillsRegistryPlugin(entry: string): string {
  return [
    `globalThis[Symbol.for(${JSON.stringify(servedSkillsRegistryKey)})] = () => import(${JSON.stringify(pathToFileURL(entry).href)})`,
    "",
    "export default () => {}",
    "",
  ].join("\n")
}

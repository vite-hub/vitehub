/** Where the generated Nitro plugin leaves the task registry, for the `task.*` operations. */
export const taskRegistryKey = "vitehub.task.registry"

/** The Nitro plugin that hands `#nitro/virtual/tasks` to the operations. It imports nothing from ViteHub. */
export function renderTaskRegistryPlugin(): string {
  return [
    "import { tasks } from '#nitro/virtual/tasks'",
    "",
    `globalThis[Symbol.for(${JSON.stringify(taskRegistryKey)})] = tasks`,
    "",
    "export default () => {}",
    "",
  ].join("\n")
}

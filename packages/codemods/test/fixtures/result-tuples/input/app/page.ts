// Outside server/, a free name is not the Nuxt auto-import.
export async function start() {
  return startWorkflow("onboard-user", {})
}

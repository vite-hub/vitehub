import { getQueue, runQueue } from "./barrel"

export async function welcome() {
  await getQueue("welcome")
  return runQueue("welcome", { id: "welcome" })
}

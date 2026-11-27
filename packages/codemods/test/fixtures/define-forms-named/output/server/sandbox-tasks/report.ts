import { defineSandboxTask } from "vite-hub/sandbox/task"

const run = async ({ month }: { month: string }) => ({ month, rows: [] as string[] })

export default defineSandboxTask({ handler: run, timeout: 60_000 })

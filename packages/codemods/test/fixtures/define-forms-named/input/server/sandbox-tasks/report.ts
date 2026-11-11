import { defineSandboxTask } from "vite-hub/sandbox/task"

const run = async ({ month }: { month: string }) => ({ month, rows: [] as string[] })

export default defineSandboxTask({ run, timeout: 60_000 })

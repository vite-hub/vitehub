import { vi } from "vitest"
import { startWorkflow } from "vite-hub/workflow"

vi.mock("vite-hub/workflow", () => ({ runWorkflow: vi.fn(async () => ({ id: "run-1" })) }))

export const started = () => startWorkflow("onboard", {})

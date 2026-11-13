import { vi } from "vitest"
import { withAgentProcessHost, createProcessAgentCapacity } from "@vite-hub/agent/process"

vi.mock("@vite-hub/agent/process", async () => await vi.importActual("@vite-hub/agent/process"))

export const host = { withAgentProcessHost, createProcessAgentCapacity }

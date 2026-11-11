import { vi } from "vitest"
import { withAgentProcessHost } from "@vite-hub/agent/process-host"
import { createProcessAgentCapacity } from "@vite-hub/agent/runtime/process"

vi.mock("@vite-hub/agent/runtime/process", async () => await vi.importActual("@vite-hub/agent/runtime/process"))

export const host = { withAgentProcessHost, createProcessAgentCapacity }

import { agentDiagnostics } from "../agent-diagnostics.ts"

export function agentGeneratedRuntimeError(
  code: "AGENT_R0892" | "AGENT_R0893" | "AGENT_R0894" | "AGENT_R0895" | "AGENT_R0896" | "AGENT_R0897",
  message: string,
): Error {
  switch (code) {
    case "AGENT_R0892": return agentDiagnostics.AGENT_R0892({ message })
    case "AGENT_R0893": return agentDiagnostics.AGENT_R0893({ message })
    case "AGENT_R0894": return agentDiagnostics.AGENT_R0894({ message })
    case "AGENT_R0895": return agentDiagnostics.AGENT_R0895({ message })
    case "AGENT_R0896": return agentDiagnostics.AGENT_R0896({ message })
    case "AGENT_R0897": return agentDiagnostics.AGENT_R0897({ message })
  }
}

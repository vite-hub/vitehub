import type { AgentCapabilityRuntimeContext } from "../types.ts"

type InspectionContext = Pick<AgentCapabilityRuntimeContext, "invocation">

const inspectionContexts = new WeakSet<InspectionContext>()

export function markCapabilityInspection(context: InspectionContext): void {
  inspectionContexts.add(context)
}

export function isCapabilityInspection(context: InspectionContext): boolean {
  return inspectionContexts.has(context)
}

const inspectionContexts = new WeakSet<object>()

export function markCapabilityInspection(context: object): void {
  inspectionContexts.add(context)
}

export function isCapabilityInspection(context: object): boolean {
  return inspectionContexts.has(context)
}

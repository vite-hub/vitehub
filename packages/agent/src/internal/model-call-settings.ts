const modelCallSettings = new WeakMap<object, Record<string, unknown>>()

export function setModelCallSettings<T>(model: T, settings: Record<string, unknown>): T {
  if ((typeof model === "object" && model !== null) || typeof model === "function") {
    modelCallSettings.set(model, settings)
  }
  return model
}

export function getModelCallSettings(model: unknown): Record<string, unknown> | undefined {
  if ((typeof model !== "object" || model === null) && typeof model !== "function") return
  return modelCallSettings.get(model)
}

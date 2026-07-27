export async function loadAiSdk(): Promise<typeof import("ai")> {
  return await import("ai")
}

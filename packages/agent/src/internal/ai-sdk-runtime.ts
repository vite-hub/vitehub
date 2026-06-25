const aiSdkPackageName = "ai"

export async function loadAiSdk(): Promise<typeof import("ai")> {
  return await import(/* @vite-ignore */ aiSdkPackageName) as typeof import("ai")
}

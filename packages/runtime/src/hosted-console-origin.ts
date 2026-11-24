declare const __VITEHUB_CONSOLE_URL__: string | undefined

/** The origin of the hosted Console. */
export const hostedConsoleOrigin = "https://console.vitehub.dev"

/**
 * The origin of the ViteHub Console that opens this app: `vitehub({ console: { url } })` of a self-hosted Console, else
 * the hosted Console.
 */
export function configuredConsoleOrigin(): string {
  return typeof __VITEHUB_CONSOLE_URL__ === "string" ? __VITEHUB_CONSOLE_URL__ : hostedConsoleOrigin
}

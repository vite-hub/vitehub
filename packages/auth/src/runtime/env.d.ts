// Auth reads the generated Server Env as a plain record. It does not know the fields that the app declares.
export function useServerEnv(event?: import("@vite-hub/runtime").ViteHubContext): Record<string, unknown>

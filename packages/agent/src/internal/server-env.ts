const serverEnvModuleId = "#vitehub/env/server"

export interface ServerEnvModule {
  useServerEnv?: (event?: unknown) => unknown
}

/** Imports the generated Server Env module. It fails when the application has no Env Vite plugin. */
export async function importServerEnvModule(): Promise<ServerEnvModule> {
  // The Env Vite plugin rewrites the tagged import to its generated module.
  // SAFETY: The generated Server Env module exposes the optional useServerEnv entrypoint.
  return await import(/* @vite-ignore */ /* @vitehub-env */ serverEnvModuleId) as ServerEnvModule
}

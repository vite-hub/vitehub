declare module "#vitehub/env/public" {
  export interface PublicEnv extends Record<string, unknown> {}
  export const publicEnv: PublicEnv
  export function usePublicEnv(): PublicEnv
}

export {}

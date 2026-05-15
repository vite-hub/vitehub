declare module "agents" {
  export function routeAgentRequest(
    request: Request,
    env: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Response | undefined> | Response | undefined
}

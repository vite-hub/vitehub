// For ViteHub packages: Driver routing and Agent Invocations. Applications import `@vite-hub/gateways`.
export { aiGatewayAsks, aiGatewaySupports, normalizeAiGateway, resolveAiGatewayDriverRoute, resolveAiGatewaySecret } from "./definition.ts"
export type { AiGatewayDriverRoute } from "./definition.ts"
export { aiGatewayEnvNames } from "./env.ts"
export type { AiGatewayEnvFieldName, AiGatewayEnvPreset } from "./env.ts"
export type { AiGatewayTraceEvent } from "./jev.ts"
export { askAiGateway } from "./presets.ts"

export { isChatGPTGateway } from "./chatgpt.ts"

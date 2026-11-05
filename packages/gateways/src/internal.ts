// For ViteHub packages: model API routing and Agent Invocations. Applications import `@vite-hub/gateways`.
export { aiGatewayAsks, aiGatewaySupports, normalizeAiGateway, resolveAiGatewayModelRoute, resolveAiGatewayRoute, resolveAiGatewaySecret } from "./definition.ts"
export type { AiGatewayModelRoute, AiGatewayResolvedRoute } from "./definition.ts"
export { aiGatewayEnvNames } from "./env.ts"
export type { AiGatewayEnvFieldName, AiGatewayEnvPreset } from "./env.ts"
export type { AiGatewayTraceEvent } from "./jev.ts"
export { askAiGateway } from "./presets.ts"

export { isChatGPTGateway } from "./chatgpt.ts"

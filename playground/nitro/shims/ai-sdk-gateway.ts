function unsupportedGateway() {
  throw new Error("@ai-sdk/gateway is not available in the Cloudflare Nitro playground build.")
}

export const gateway = unsupportedGateway
export const createGateway = unsupportedGateway

export class GatewayAuthenticationError extends Error {}

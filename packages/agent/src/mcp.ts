import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"
import type { McpClientConfig } from "./mcp/types.ts"

export type RemoteMcpServerTransport = "http" | "sse"

export interface RemoteMcpServerOptions extends Omit<Extract<AiSdkMcpClientConfig["transport"], { type: "http" | "sse" }>, "type"> {
  type?: RemoteMcpServerTransport
}

export function remoteMcpServer(options: RemoteMcpServerOptions): McpClientConfig {
  return {
    transport: {
      ...options,
      type: options.type || "http",
    },
  }
}

export type {
  MCPClient,
  MCPTransport,
} from "@ai-sdk/mcp"
export type { McpClientConfig as MCPClientConfig } from "./mcp/types.ts"

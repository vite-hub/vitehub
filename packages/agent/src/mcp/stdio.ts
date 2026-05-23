import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"

import type { StdioConfig } from "@ai-sdk/mcp/mcp-stdio"
import type { McpClientConfig } from "./types.ts"

export interface StdioMcpServerOptions extends StdioConfig {}

export function stdioMcpServer(options: StdioMcpServerOptions): McpClientConfig {
  return {
    transport: new Experimental_StdioMCPTransport(options),
  }
}

export type { StdioConfig } from "@ai-sdk/mcp/mcp-stdio"

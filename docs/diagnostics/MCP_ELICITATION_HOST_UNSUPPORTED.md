---
description: "Fix MCP_ELICITATION_HOST_UNSUPPORTED in ViteHub. A tool calls elicit() in a build for a host where the answer of the client can reach another server instance."
seo.title: "MCP_ELICITATION_HOST_UNSUPPORTED"
---

`elicit()` of an MCP tool throws `MCP_ELICITATION_HOST_UNSUPPORTED`. The app is built for a host where the answer of the MCP client can reach another server instance than the tool call that waits for it. The message names the host. The Agent reads the code and the message as a tool error.

## Why it happens

The MCP client answers `elicitation/create` with a new HTTP request. The tool call waits for that answer in the memory of the server process. One Node, Bun, or Deno server process gets both requests, so the answer always finds the call. Cloudflare Workers, Vercel, Netlify, Deno Deploy, and `node-cluster` run many instances, and the answer can reach an instance that does not have the call.

The build reads the host from the Nitro preset. These presets support `elicit()`: `node-server`, `node-middleware`, `bun`, and `deno-server`. The dev server always does.

## Fix it

Deploy the MCP server as one server process, such as the default `node-server` preset.

On a host with many instances, take the values as tool arguments, and let the Agent ask the person in the chat:

```ts [server/mcp/tools/share_drop.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Share a drop with a teammate. Ask the person for the email and the role first.',
  input: z.object({ drop: z.string(), email: z.email(), role: z.enum(['viewer', 'editor']) }),
  handler: ({ drop, email, role }) => ({ drop, email, role }),
})
```

## Related

- [Ask the person for values](/docs/mcp/server-api#ask-the-person-for-values)
- [MCP server limits and errors](/docs/mcp/limits-and-errors)

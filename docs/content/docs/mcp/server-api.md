---
title: MCP server API
description: Every option of defineMcpTool(), defineMcpPrompt(), and defineMcpResource(), what a handler gets and returns, and how it reports an error to the Agent.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Import `defineMcpTool()`, `defineMcpPrompt()`, and `defineMcpResource()` from `vite-hub/mcp`. It re-exports `@vite-hub/mcp`.

## Define a tool

Put one `defineMcpTool()` default export in each file of `server/mcp/tools/`. The tool name is the file path below `mcp/tools/` without the extension.

```ts [server/mcp/tools/add.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

| Option | Use |
| --- | --- |
| `description` | What the tool does and when an Agent calls it. Agents read it to pick the tool. Required. |
| `title` | A short name for people, such as "List drops". |
| `input` | The arguments: a Standard Schema that also gives its JSON Schema, such as a Zod 4 object or a Valibot schema in `toStandardJsonSchema()`. `tools/list` shows its JSON Schema. |
| `annotations` | The MCP tool annotations that clients read before a call: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. |
| `public` | Set `true` to include the tool on `mcp.publicRoute`. See [Public tools](/docs/mcp/configure#serve-public-tools-without-sign-in). |
| `handler` | Runs the call. |

The server checks the arguments with `input` before the handler runs. Invalid arguments are a tool error for protocol `2025-11-25`, or JSON-RPC `-32602` for `2025-06-18`.

## Write the handler

The handler gets the checked input and `{ event, caller }`:

- `event` is the H3 event of the MCP request. `event.req` is the web `Request`.
- `caller` is the signed-in caller when `mcpOAuth()` protects the server, else `undefined`. It has the Auth `user`, the approved `scopes`, the OAuth `clientId`, and the `clientName`, such as `Claude Code`. The server reads the user again for each request, so a deleted or banned person has no access.

The return value becomes the tool result:

| Return | Result |
| --- | --- |
| A string | One text block. |
| `{ content: [...] }` | The MCP content blocks as they are, such as an image. |
| Another value | JSON text. An object is also the `structuredContent`. |

## Report an error

Throw an error with a 4xx `status`, such as H3's `HTTPError`, to tell the Agent what to fix. The Agent reads its message as a tool error. Other errors are logged, and the Agent reads only `<name> failed on the server.`

## Define a prompt

A prompt is a message template that people pick in the MCP client, such as a slash command. Put one `defineMcpPrompt()` default export in each file of `server/mcp/prompts/`. The prompt name is the file path below `mcp/prompts/` without the extension.

```ts [server/mcp/prompts/address_feedback.ts]
import { defineMcpPrompt } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpPrompt({
  title: 'Address review feedback',
  description: 'Read the open comments on a drop and publish the next version.',
  input: z.object({ id: z.string().describe('The drop id from list_drops.') }),
  handler: ({ id }) => `Call read_drop for drop ${id}, address every open comment, and publish the next version.`,
})
```

| Option | Use |
| --- | --- |
| `description` | What the prompt does. Clients show it. |
| `title` | A short name for people. |
| `input` | The arguments: an object Standard Schema with string fields. `prompts/list` shows each field as an argument, with its description, and marks the fields that are not optional as required. |
| `public` | Set `true` to include the prompt on `mcp.publicRoute`. |
| `handler` | Makes the messages. It gets the checked input and `{ event, caller }`, as a tool handler does. |

A string becomes one user message. Return an array of `{ role, content }` messages for more messages, or `{ description, messages }` for the full result. Invalid arguments get JSON-RPC `-32602`, and so does a thrown error with a 4xx `status`.

## Define a resource

A resource is data that the client reads by its URI, such as a file. Put one `defineMcpResource()` default export in each file of `server/mcp/resources/`. The resource name is the file path below `mcp/resources/` without the extension.

Set `uri` for one resource:

```ts [server/mcp/resources/changelog.ts]
import { defineMcpResource } from 'vite-hub/mcp'

export default defineMcpResource({
  uri: 'docs://changelog',
  title: 'Changelog',
  mimeType: 'text/markdown',
  handler: () => '# Changelog',
})
```

Set `uriTemplate` for a family of resources, such as the files of each skill. `{name}` matches one path segment, and `{+name}` also matches `/`. The handler gets the values in `variables`. Add `list` to show the resources in `resources/list`:

```ts [server/mcp/resources/skill_file.ts]
import { defineMcpResource } from 'vite-hub/mcp'

const files: Record<string, string> = { 'drop/SKILL.md': '# Drop', 'drop/references/api.md': '# API' }

export default defineMcpResource({
  uriTemplate: 'skill://{name}/{+path}',
  description: 'A file of a skill.',
  mimeType: 'text/markdown',
  list: () => Object.keys(files).map(file => ({ uri: `skill://${file}` })),
  handler: (uri, { variables }) => files[`${variables.name}/${variables.path}`],
})
```

| Option | Use |
| --- | --- |
| `uri` | The URI of one resource. |
| `uriTemplate` | An RFC 6570 URI template for a family of resources. Set `uri` or `uriTemplate`, not both. |
| `list` | With `uriTemplate`, the resources that `resources/list` shows: `uri`, and optional `name`, `title`, `description`, `mimeType`, and `size`. |
| `title`, `description` | What the resource is. |
| `mimeType` | The MIME type of the contents, such as `text/markdown`. |
| `public` | Set `true` to include the resource on `mcp.publicRoute`. |
| `handler` | Reads the resource. It gets the URI and `{ event, caller, variables }`. |

| Return | Result |
| --- | --- |
| A string | The text of the resource. |
| A `Uint8Array` | The bytes, as a base64 `blob`. |
| `{ contents: [...] }` | The MCP resource contents as they are. |
| `undefined` | JSON-RPC `-32002`: the resource does not exist. |

A thrown error with a 4xx `status` gets JSON-RPC `-32602` with its message. Other errors are logged, and the client reads only `<name> failed on the server.`

The server advertises the `prompts` and `resources` capabilities only when the app has prompts or resources.

## Public imports

| Import | Use |
| --- | --- |
| `vite-hub/mcp` | `defineMcpTool()`, `defineMcpPrompt()`, `defineMcpResource()`, and their types. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |

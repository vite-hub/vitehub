---
title: MCP server API
description: Every option of defineMcpTool(), defineMcpPrompt(), defineMcpResource(), and defineMcpHooks(), and what a handler gets and returns.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Import `defineMcpTool()`, `defineMcpPrompt()`, `defineMcpResource()`, and `defineMcpHooks()` from `vite-hub/mcp`. It re-exports `@vite-hub/mcp`.

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
| `_meta` | Metadata that `tools/list` shows for the client, not the model, such as `{ ui: { resourceUri } }`. See [Show a UI in the chat](#show-a-ui-in-the-chat). |
| `access` | Set `'public'` to let anyone call the tool without sign-in, with `mcp.auth: 'optional'` or on `mcp.publicRoute`. Without one of them, the server fails with `MCP_R0001`. See [Public tools](/docs/mcp/configure#let-anyone-call-some-tools). |
| `scopes` | The OAuth scopes that a signed-in caller needs, such as `['lessons:write']`. With `auth: true`, a caller without them does not see the tool, and a call gets `403` with an `insufficient_scope` challenge. With `auth: 'optional'`, a call gets a tool error with that challenge. |
| `handler` | Runs the call. |

The server checks the arguments with `input` before the handler runs. Invalid arguments are a tool error for protocol `2025-11-25`, or JSON-RPC `-32602` for `2025-06-18`.

## Write the handler

The handler gets the checked input and `{ event, caller, elicit }`:

- `event` is the H3 event of the MCP request. `event.req` is the web `Request`.
- `caller` is the signed-in caller when `mcpOAuth()` protects the server, else `undefined`. It has the Auth `user`, the approved `scopes`, the OAuth `clientId`, and the `clientName`, such as `Claude Code`. The server reads the user again for each request, so a deleted or banned person has no access.
- `elicit` asks the person for values in the middle of the call. See [Ask the person for values](#ask-the-person-for-values).

The return value becomes the tool result:

| Return | Result |
| --- | --- |
| A string | One text block. |
| `{ content: [...] }` | The MCP content blocks as they are, such as an image, with `structuredContent`, `isError`, and `_meta` when you set them. |
| Another value | JSON text. An object is also the `structuredContent`. |

## Report an error

Throw an error with a 4xx `status`, such as H3's `HTTPError`, to tell the Agent what to fix. The Agent reads its message as a tool error. Other errors are logged, and the Agent reads only `<name> failed on the server.`

## Ask the person for values

`elicit(form, { message })` shows a form to the person in the MCP client, such as Claude or Cursor, and waits for the answer. MCP calls this elicitation. The form is a `defineForm()` form of `vite-hub/forms`, or a Standard Schema of a flat object, such as a Zod object:

```ts [server/mcp/tools/share_drop.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

const Invite = z.object({
  email: z.email().describe('The email of your teammate.'),
  role: z.enum(['viewer', 'editor']),
})

export default defineMcpTool({
  description: 'Share a drop with a teammate. Asks the person who gets access.',
  input: z.object({ drop: z.string() }),
  handler: async ({ drop }, { elicit }) => {
    const [error, answer] = await elicit(Invite, { message: `Who gets access to ${drop}?` })
    if (error) return `The answer is not valid: ${error.issues.map(issue => issue.message).join(' ')}`
    if (answer.action !== 'accept') return `The person did not share ${drop}.`
    return { drop, email: answer.data.email, role: answer.data.role }
  },
})
```

`elicit()` returns `[error, answer]`:

- `answer.action` is `accept` with the checked values in `answer.data`, `decline` when the person refused, or `cancel` when the person closed the form or did not answer in 10 minutes.
- `error` has the issue of each field when the values do not pass the schema, the same issues as the [form route](/docs/forms/server-api). Call `elicit()` again to ask again.

A tool that elicits answers the `tools/call` with an event stream. Tools that do not elicit keep a JSON answer. Do not ask for passwords, API keys, or payment details: MCP does not allow them in a form.

`elicit()` throws, and the Agent reads the reason as a tool error, in two cases:

| Code | Cause |
| --- | --- |
| [`MCP_ELICITATION_CLIENT_UNSUPPORTED`](/docs/mcp/diagnostics/mcp_elicitation_client_unsupported) | The MCP client did not declare the `elicitation` capability. |
| [`MCP_ELICITATION_HOST_UNSUPPORTED`](/docs/mcp/diagnostics/mcp_elicitation_host_unsupported) | The build is for a host that can send the answer to another server instance. |

The waiting call stays in the memory of the server process, so the answer of the client must reach the same process. That works on the dev server and in builds for one Node, Bun, or Deno server process: the `node-server`, `node-middleware`, `bun`, and `deno-server` presets. It does not work on Cloudflare Workers, Vercel, Netlify, Deno Deploy, or `node-cluster`.

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
| `access` | Set `'public'` to let anyone get the prompt without sign-in. |
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

const files: Record<string, string> = { 'recipes/SKILL.md': '# Recipes', 'recipes/references/api.md': '# API' }

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
| `_meta` | Metadata of the resource in `resources/list`, and of the contents that a string or `Uint8Array` handler returns. |
| `access` | Set `'public'` to let anyone read the resource without sign-in. An MCP App sets it on its `ui://` resource when its tool is public. |
| `handler` | Reads the resource. It gets the URI and `{ event, caller, variables }`. |

| Return | Result |
| --- | --- |
| A string | The text of the resource. |
| A `Uint8Array` | The bytes, as a base64 `blob`. |
| `{ contents: [...] }` | The MCP resource contents as they are. |
| `undefined` | JSON-RPC `-32002`: the resource does not exist. |

A thrown error with a 4xx `status` gets JSON-RPC `-32602` with its message. Other errors are logged, and the client reads only `<name> failed on the server.`

The server advertises the `prompts` and `resources` capabilities only when the app has prompts or resources.

## Show a UI in the chat

An MCP App is a tool whose result the client shows as an HTML page in the chat, such as a player or a chart. ChatGPT and Claude show them. The HTML is a resource with a `ui://` URI and the MIME type `text/html;profile=mcp-app`, and the tool names that resource in `_meta.ui.resourceUri`:

```ts [server/mcp/resources/player.ts]
import { defineMcpResource } from 'vite-hub/mcp'

export default defineMcpResource({
  uri: 'ui://lessons/player.html',
  title: 'Lesson player',
  mimeType: 'text/html;profile=mcp-app',
  _meta: { ui: { csp: { connectDomains: ['https://lessons.example.com'], resourceDomains: ['https://lessons.example.com'] }, prefersBorder: false } },
  handler: () => '<!doctype html><div id="player"></div><script type="module" src="https://lessons.example.com/player.js"></script>',
})
```

```ts [server/mcp/tools/show_lesson.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Play a lesson in the chat.',
  input: z.object({ lessonId: z.string() }),
  _meta: { 'ui': { resourceUri: 'ui://lessons/player.html' }, 'openai/outputTemplate': 'ui://lessons/player.html' },
  handler: ({ lessonId }) => ({
    content: [{ type: 'text', text: `Playing lesson ${lessonId}.` }],
    structuredContent: { lessonId },
  }),
})
```

- `_meta.ui.resourceUri` tells the client which resource to show for the result. `openai/outputTemplate` is the older ChatGPT name for the same thing.
- `_meta.ui.csp` lists the origins that the page may fetch from (`connectDomains`) and load scripts, styles, and images from (`resourceDomains`). The client blocks other origins.
- The page reads `structuredContent` of the result. The model reads `content` and `structuredContent`. Put data that only the page needs in the `_meta` of the result.

The server sends every `_meta` as it is. To compute the `_meta` of the contents for each request, return `{ contents: [{ uri, mimeType, text, _meta }] }` from the resource handler. See the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx) for the `ui` fields and the [OpenAI Apps SDK reference](https://developers.openai.com/apps-sdk/reference) for the `openai/` keys.

## Resolve the caller and log tool calls

Put one `defineMcpHooks()` default export in `server/mcp.ts`. The server calls its functions for each request:

```ts [server/mcp.ts]
import { defineMcpHooks } from 'vite-hub/mcp'
import { HTTPError } from 'h3'

const members = new Map([['user-1', { teamId: 'core' }]])
const findMember = async (userId: string) => members.get(userId)

export default defineMcpHooks({
  async resolveCaller({ caller }) {
    const member = caller && await findMember(caller.user.id)
    if (!member) throw new HTTPError({ message: 'Join a team first.', status: 403 })
    return member
  },
  onToolCall({ name, caller, durationMs, result }) {
    console.info('mcp tool', { name, team: caller?.teamId, durationMs, failed: result.isError })
  },
})
```

| Function | Use |
| --- | --- |
| `verifyToken` | Accepts a bearer token that is not an access token of `mcpOAuth()`, such as an API key. It gets `{ event, token }` and returns the caller, with `user`, `scopes`, `clientId`, and `clientName`, or `undefined` to answer `401`. See [Accept API keys](#accept-api-keys). |
| `resolveCaller` | Maps the caller to the app's own identity. It gets `{ event, caller }`, where `caller` is the signed-in caller of `mcpOAuth()`, else `undefined`. Its return value is `caller` in every tool, prompt, and resource handler. |
| `onToolCall` | Runs after each tool call with `name`, `input`, `caller`, `event`, `durationMs`, `result`, and `error`. |

`resolveCaller` runs once per request, when the first handler runs, so `initialize` and `tools/list` read no app data. A thrown error with a 4xx `status` refuses the call with its message. ViteHub writes `.vitehub/types/mcp.d.ts`, so `caller` in the handlers has the type that `resolveCaller` returns.

`onToolCall` runs for each call whose arguments passed `input`, before the server sends the answer. `durationMs` is the time of the handler. `result` is what the Agent reads, with `isError: true` for a failed call. `error` is what the handler or `resolveCaller` threw, and is absent when nothing threw. An error that `onToolCall` throws is logged, and the result does not change.

## Accept API keys

Scripts that cannot do OAuth send another bearer token, such as an API key. `verifyToken` checks it and returns the caller, so `resolveCaller` and the handlers get it the same way as the caller of an access token:

```ts [server/mcp.ts]
import { defineMcpHooks } from 'vite-hub/mcp'

const apiKeys = new Map([['fin_3kq9Xb7Lm2', { userId: 'user-1', name: 'Budget script' }]])

export default defineMcpHooks({
  verifyToken({ token }) {
    const key = apiKeys.get(token)
    return key && { user: { id: key.userId }, scopes: [], clientId: undefined, clientName: key.name }
  },
})
```

With the API key plugin of Better Auth, call `useAuth(event).api.verifyApiKey({ body: { key: token } })` there instead of the map.

The server calls `verifyToken` only when `auth` is on and the bearer token is not a valid access token of `mcpOAuth()`. A request without a token never reaches it. When it returns `undefined`, the request gets `401` with `error="invalid_token"`. An error that it throws fails the request.

## Public imports

| Import | Use |
| --- | --- |
| `vite-hub/mcp` | `defineMcpTool()`, `defineMcpPrompt()`, `defineMcpResource()`, `defineMcpHooks()`, and their types. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |

---
title: ViteHub MCP
seo.title: ViteHub MCP server for docs and your apps
description: Connect an agent to the ViteHub MCP of the Console, for the docs and for the apps of your team.
navigation.order: 32.2
navigation.group: Local tools
icon: i-lucide-plug
---

The ViteHub MCP is an [MCP](https://modelcontextprotocol.io) server that runs in the [ViteHub Console](/docs/development/console). It has two addresses:

| URL | Sign-in | Tools |
| --- | --- | --- |
| `https://console.vitehub.dev/mcp` | None | Docs tools: search and read the ViteHub docs. |
| `https://console.vitehub.dev/mcp/account` | Your Console account, with OAuth | Docs tools, and project tools for the apps that your team linked. |

Your app does not serve an MCP server for the Console. To give your own users an MCP server, see [MCP server](/docs/mcp).

## Connect an agent

Add the docs address to read the docs, or the account address to work on your apps too. For Claude Code and Codex:

```bash [Terminal]
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

```toml [~/.codex/config.toml]
[mcp_servers.vitehub]
url = "https://console.vitehub.dev/mcp/account"
```

The account address answers `401` with OAuth metadata. The client opens the browser once, and you sign in to the Console with GitHub or a passkey. The docs address lists no OAuth metadata, so clients connect to it without asking.

## Project tools

With the account address, the agent works on the apps of your active Console team:

| Tool | Does |
| --- | --- |
| `list_apps` | Lists the apps that your team linked. |
| `link_app` | Links an app by its URL, and returns the `VITEHUB_CONSOLE_KEY_<NAME>` line to set on it. |
| `check_app` | Checks that the app takes the signed calls of its link. |
| `unlink_app` | Unlinks an app. Remove its variable from the app as well. |
| `list_operations` | Lists the [operations](/docs/development/operations) of an app that you may call, with their input schemas. |
| `run_operation` | Runs one operation of an app. |

The Console runs each operation with a [signed request](/docs/development/console#sign-console-requests), the same way as the Console UI. The app's `console.authorize` gets `via: "console"` and your Console user, so it decides what the agent may do. The agent never gets the key of the link.

An operation can shape its MCP result or stay out of MCP with its `mcp` field. `mcp: false` hides it. `mcp: { format }` turns its output into the text that the agent reads. A `destructive` operation, such as `content.publish`, asks for a confirmation before it runs.

## Move from /_vitehub/mcp

Earlier releases served a Console MCP in each app, at `/_vitehub/mcp`, with OAuth from `consoleMcpOAuth()`. It is removed. Connect the agent to `https://console.vitehub.dev/mcp/account`, link the app in the Console, and remove `consoleMcpOAuth()` and `console.mcp` from the app. See [Move from auth: "app" or Console Auth](/docs/development/console#move-from-auth-app-or-console-auth).

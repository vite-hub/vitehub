---
title: ViteHub MCP
seo.title: ViteHub MCP server for docs and your apps
description: Connect a coding agent to the ViteHub MCP to read the docs, and sign in with your Console account to run the operations of your apps.
navigation.order: 30
navigation.group: Agents and tools
icon: i-lucide-plug
---

## Connect an agent

Pick your client. Each one adds the server as `vitehub`, so prompts such as "use the vitehub MCP server" match.

::mcp-install
  :::mcp-client{label="Claude Code" icon="i-simple-icons-claude" method="Terminal"}
    1. Add the server from your terminal:

       ```bash [Terminal]
       claude mcp add --transport http vitehub https://vitehub.dev/mcp
       ```

       It is added for the current project. Add `--scope project` to share it with your team through `.mcp.json`, or `--scope user` for all your projects.
    2. Start a new session and ask Claude Code to list the `vitehub` tools.
  :::

  :::mcp-client{label="Codex" icon="i-simple-icons-openai" method="Terminal"}
    1. Add the server from your terminal:

       ```bash [Terminal]
       codex mcp add vitehub --url https://vitehub.dev/mcp
       ```

    2. The command writes this entry to `~/.codex/config.toml`. You can also add it yourself:

       ```toml [~/.codex/config.toml]
       [mcp_servers.vitehub]
       url = "https://vitehub.dev/mcp"
       ```

    3. Start a new Codex session.
  :::

  :::mcp-client{label="Cursor" icon="i-simple-icons-cursor" method="One-click install or mcp.json" install="cursor"}
    1. Select **Add to Cursor**, or add the server to `.cursor/mcp.json`:

       ```json [.cursor/mcp.json]
       {
         "mcpServers": {
           "vitehub": {
             "url": "https://vitehub.dev/mcp"
           }
         }
       }
       ```

    2. Use `~/.cursor/mcp.json` instead to add it for all your projects.
  :::

  :::mcp-client{label="VS Code" icon="i-simple-icons-visualstudiocode" method="One-click install or mcp.json" install="vscode"}
    1. Select **Add to VS Code**, or add the server to `.vscode/mcp.json`:

       ```json [.vscode/mcp.json]
       {
         "servers": {
           "vitehub": {
             "type": "http",
             "url": "https://vitehub.dev/mcp"
           }
         }
       }
       ```

    2. To add it to your user profile instead of the workspace, run:

       ```bash [Terminal]
       code --add-mcp '{"name":"vitehub","type":"http","url":"https://vitehub.dev/mcp"}'
       ```

    3. Open Copilot Chat in agent mode. GitHub Copilot uses the server there.
  :::

  :::mcp-client{label="Claude" icon="i-simple-icons-anthropic" method="Custom connector"}
    1. In Claude, open **Customize › Connectors**, then **Add connector › Add custom connector**.
    2. Name it **ViteHub**, paste `https://vitehub.dev/mcp`, and select **Add**.
    3. Start a new chat and ask Claude to list the ViteHub tools.
  :::

  :::mcp-client{label="Windsurf" icon="i-simple-icons-windsurf" method="mcp_config.json" note="Windsurf is now Devin Desktop. Older Windsurf installs use ~/.codeium/windsurf/mcp_config.json."}
    1. Open the raw MCP configuration from the Cascade MCP settings, and add the server:

       ```json [mcp_config.json]
       {
         "mcpServers": {
           "vitehub": {
             "serverUrl": "https://vitehub.dev/mcp"
           }
         }
       }
       ```

    2. Devin Desktop keeps the file at `~/.config/devin/mcp_config.json` on macOS and Linux, and at `%APPDATA%\devin\mcp_config.json` on Windows.
  :::

  :::mcp-client{label="Other" icon="i-lucide-plug" method="Any remote MCP client"}
    1. In your client's settings, add a remote MCP server named `vitehub`.
    2. Choose **Streamable HTTP** and paste `https://vitehub.dev/mcp`. The docs address needs no sign-in.
  :::
::

## Docs or your apps

The commands above use the docs address. To let the agent work on your apps too, use the account address in the same place:

| Address | Sign-in | Tools |
| --- | --- | --- |
| `https://vitehub.dev/mcp` | None | `list-pages` and `get-page`, for the docs. |
| `https://console.vitehub.dev/mcp/account` | Your Console account | The docs tools, and [project tools](#project-tools) for the apps your team linked. |

```bash [Terminal]
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

The account address answers `401` with OAuth metadata, so your client opens the Console in your browser once. Sign in with GitHub or a passkey and allow the client. `https://console.vitehub.dev/mcp` serves the same docs tools as the docs address, without sign-in.

::note
Your app serves no MCP server for the Console. To give your own users one, see [MCP server](/docs/mcp).
::

## Check the connection

Ask the agent to use both docs tools:

```txt [Prompt]
Use the vitehub MCP server to list the pages about Queue, then read the Queue page and summarize how to send a message.
```

The agent calls `list-pages`, then `get-page` with `/docs/queue`. Without an MCP client, ask for the tool list:

```bash [Terminal]
curl -s https://vitehub.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists `get-page` and `list-pages`. The docs tools never connect to your app.

## Project tools

With the account address, the agent works on the apps of the team that you opened last in the Console, with your role:

| Tool | Does |
| --- | --- |
| `list_apps` | Lists the apps that your team linked. |
| `link_app` | Links an app by its URL, and returns the `VITEHUB_CONSOLE_KEY_<NAME>` line to set on it. Only owners and admins of the team can link. |
| `check_app` | Answers `linked: true` when the app takes its link's signed calls. |
| `unlink_app` | Unlinks an app. Remove its variable from the app as well. |
| `list_operations` | Lists the [operations](/docs/console/operations) of an app that you may call, with their input schemas. |
| `run_operation` | Runs one operation of an app, such as `kv.list`. |

To link an app, have the agent call `link_app` with its URL, set the returned line in the app's environment with `console: true`, and deploy. `check_app` then answers `linked: true`.

The Console runs each operation with a [signed request](/docs/console/signed-requests), as its UI does, so the app's `console.authorize` gets `via: "console"` and your Console user and decides what the agent may do. The agent's sign-in and the link's key never reach your app or the agent. An operation's `mcp` field can hide it (`false`) or `format` its output as text. A `destructive` operation, such as `content.publish`, runs only when the agent sends `confirm: true`, so the agent asks you first.

## Use it with the ViteHub skill

The [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills) tells the agent how to work in a ViteHub project and prove the result, and the MCP gives it the current docs. Install both when the agent builds ViteHub apps, or only the docs address when you only ask about the docs.

::note
Earlier releases served a Console MCP in each app at `/_vitehub/mcp`. See [Move from earlier releases](/docs/console/migrate#move-from-the-mcp-of-the-app).
::

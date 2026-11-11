---
title: Connect the docs MCP server
navigation.group: Coding agents
description: Let your coding agent list and read ViteHub documentation pages through MCP.
navigation.title: Docs MCP server
navigation.order: 262
icon: i-lucide-plug
---

`https://vitehub.dev/mcp` is a remote MCP server for the ViteHub docs. It uses
the Streamable HTTP transport and needs no API key. It has two read-only tools:

| Tool | Result |
| --- | --- |
| `list-pages` | The title, path, description, and URL of every documentation page. |
| `get-page` | The title, description, URL, and Markdown content of one page. Use a path from `list-pages`, for example `/docs/kv`. |

The server only reads the docs. It does not connect to your app or run ViteHub operations. For your apps, use the [Console address](#use-your-apps-through-the-console).

## Add the server to your client

Name the server `vitehub` so prompts such as "use the vitehub MCP server" match.

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    claude mcp add --transport http vitehub https://vitehub.dev/mcp
    ```

    This adds the server for you in the current project.
    Add `--scope project` to share it with the team through `.mcp.json`, or `--scope user` for all your projects.
  :::

  :::tabs-item{label="Cursor" icon="i-simple-icons-cursor"}
    ```json [.cursor/mcp.json]
    {
      "mcpServers": {
        "vitehub": {
          "url": "https://vitehub.dev/mcp"
        }
      }
    }
    ```

    Use `~/.cursor/mcp.json` for all projects.
    You can also select **Add MCP server to Cursor** in the page actions menu next to any docs page title.
  :::

  :::tabs-item{label="VS Code" icon="i-simple-icons-visualstudiocode"}
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

    GitHub Copilot uses the server in agent mode.
    To add it to your user profile instead of the workspace, run:

    ```bash [Terminal]
    code --add-mcp '{"name":"vitehub","type":"http","url":"https://vitehub.dev/mcp"}'
    ```

    You can also select **Add MCP server to VS Code** in the page actions menu.
  :::

  :::tabs-item{label="Windsurf" icon="i-simple-icons-windsurf"}
    ```json [mcp_config.json]
    {
      "mcpServers": {
        "vitehub": {
          "serverUrl": "https://vitehub.dev/mcp"
        }
      }
    }
    ```

    Windsurf is now Devin Desktop. Open the raw MCP configuration from the Cascade MCP settings, or edit the file.
    Devin Desktop uses `~/.config/devin/mcp_config.json` on macOS and Linux and `%APPDATA%\devin\mcp_config.json` on Windows. Older Windsurf installs use `~/.codeium/windsurf/mcp_config.json`.
  :::

  :::tabs-item{label="Codex" icon="i-simple-icons-openai"}
    ```bash [Terminal]
    codex mcp add vitehub --url https://vitehub.dev/mcp
    ```

    The command writes this entry to `~/.codex/config.toml`. You can also add it yourself:

    ```toml [~/.codex/config.toml]
    [mcp_servers.vitehub]
    url = "https://vitehub.dev/mcp"
    ```
  :::
::

## Check the connection

Ask the agent to use both tools:

```txt [Prompt]
Use the vitehub MCP server to list the pages about Queue, then read the Queue page and summarize how to send a message.
```

The agent calls `list-pages`, selects `/docs/queue`, and calls `get-page` with that path.

To check the endpoint without an MCP client, ask for the tool list:

```bash [Terminal]
curl -s https://vitehub.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists `get-page` and `list-pages`.

## Use your apps through the Console

The ViteHub Console serves the same MCP on two addresses:

| Address | Sign-in | Tools |
| --- | --- | --- |
| `https://console.vitehub.dev/mcp` | None | `list-pages` and `get-page`, the docs tools above. |
| `https://console.vitehub.dev/mcp/account` | Your Console account, with OAuth | The docs tools, and tools for the apps of your team: `list_apps`, `link_app`, `check_app`, `unlink_app`, `list_operations`, and `run_operation`. |

Add the account address to your client:

```bash [Terminal]
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

The client opens the Console in your browser. Sign in with GitHub or a passkey, and allow the client. The tools act on the team that you opened last in the Console, with your role in it.

To link an app, ask the agent to call `link_app` with the URL of the app. Only owners and admins of the team can link. The answer has one variable line with the public key of the link, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`. Set it in the environment of the app, set `console: { auth: 'token' }` in its ViteHub config, and deploy. Then `check_app` answers `linked: true`.

`run_operation` runs one operation of the app, such as `kv.list`. The Console signs the call for you as an MCP call, and the agent's sign-in never reaches your app. Your app applies its MCP rules: it refuses operations that it keeps from MCP clients, and runs an operation that deletes or publishes data only when the agent sends `confirm: true`, so the agent asks you first.

## Use the server with the skill

The [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills) tells the agent how to work in a ViteHub project and prove the result. The MCP server lets it read the current docs during the task.
Install both when the agent builds ViteHub apps. Use the MCP server alone when you only ask questions about the docs.

To let the agent also work on the apps of your Console team, connect the [ViteHub MCP](/docs/development/mcp) at `https://console.vitehub.dev/mcp/account` instead. It has the docs tools too.

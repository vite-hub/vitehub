---
title: Connect the docs MCP server
description: Let your coding agent list and read ViteHub documentation pages through MCP.
navigation.title: Docs MCP server
navigation.order: 62
icon: i-lucide-plug
---

`https://vitehub.dev/mcp` is a remote MCP server for the ViteHub documentation.
It uses the Streamable HTTP transport and does not need an API key.

The server has two read-only tools:

| Tool | Result |
| --- | --- |
| `list-pages` | The title, path, description, and URL of every documentation page. |
| `get-page` | The title, description, URL, and Markdown content of one page. Use a path from `list-pages`, for example `/docs/server-primitives/kv`. |

The server reads the documentation only. It does not connect to your application and does not run ViteHub operations.

## Add the server to your client

Use `vitehub` as the server name, so that prompts such as "use the vitehub MCP server" match.

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    claude mcp add --transport http vitehub https://vitehub.dev/mcp
    ```

    The server is available to you in the current project.
    Add `--scope project` to share it with the team through `.mcp.json`, or `--scope user` to use it in all your projects.
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

    Use `~/.cursor/mcp.json` to make the server available in all projects.
    You can also select **Add MCP server to Cursor** in the page actions menu next to the title of any docs page.
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
    To add the server to your user profile instead of the workspace, run:

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

    Windsurf is now Devin Desktop. Open the raw MCP configuration from the Cascade MCP settings, or edit the file directly.
    Current Devin Desktop installations use `~/.config/devin/mcp_config.json` on macOS and Linux and `%APPDATA%\devin\mcp_config.json` on Windows. Earlier Windsurf installations use `~/.codeium/windsurf/mcp_config.json`.
  :::

  :::tabs-item{label="Codex" icon="i-simple-icons-openai"}
    ```bash [Terminal]
    codex mcp add vitehub --url https://vitehub.dev/mcp
    ```

    The command writes this entry to `~/.codex/config.toml`. You can also add it by hand:

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

The agent calls `list-pages`, selects `/docs/server-primitives/queue`, and calls `get-page` with that path.

To check the endpoint without an MCP client, request the tool list:

```bash [Terminal]
curl -s https://vitehub.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists `get-page` and `list-pages`.

## Use the server with the skill

The MCP server and the [ViteHub skill](/docs/ai-resources/agent-instructions-skills) do different jobs.
The skill tells the agent how to work in a ViteHub project and how to prove the result. The MCP server lets the agent find and read the current documentation during the task.
Install both when the agent builds ViteHub applications. Use the MCP server alone when you only ask questions about the documentation.

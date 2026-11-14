---
title: ViteHub MCP
seo.title: ViteHub MCP server for docs and your apps
description: Connect a coding agent to the ViteHub MCP to read the docs, and sign in with your Console account to run the operations of your apps.
navigation.order: 30
navigation.group: Agents and tools
icon: i-lucide-plug
---

Connect your coding agent to the ViteHub MCP and it reads the current ViteHub docs while it works. Sign in with your Console account, and it can also run operations on your team's apps. It is one [MCP](https://modelcontextprotocol.io) server over Streamable HTTP, at two addresses:

| Address | Sign-in | Tools |
| --- | --- | --- |
| `https://vitehub.dev/mcp` | None | Docs tools: `list-pages` and `get-page`. |
| `https://console.vitehub.dev/mcp/account` | Your Console account, with OAuth | The docs tools, and project tools for the apps that your team linked. |

`https://console.vitehub.dev/mcp` serves the same docs tools without sign-in. Name the server `vitehub` in your client, so prompts such as "use the vitehub MCP server" match. Your app serves no Console MCP; to give your own users one, see [MCP server](/docs/mcp).

## Connect an agent

The docs address has no OAuth metadata, so clients connect without asking. The account address answers `401` with OAuth metadata, so the client opens the Console in your browser once to sign in with GitHub or a passkey and allow it.

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    claude mcp add --transport http vitehub https://vitehub.dev/mcp
    ```

    This adds the server for you in the current project.
    Add `--scope project` to share it with the team through `.mcp.json`, or `--scope user` for all your projects.
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
::

For the account address, put `https://console.vitehub.dev/mcp/account` in the same place:

```bash [Terminal]
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

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

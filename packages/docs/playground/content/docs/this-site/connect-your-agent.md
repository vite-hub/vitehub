---
title: Connect your agent
description: Add the ViteHub Console MCP server to Claude Code or Codex, sign in once, and let your agent read and edit pages.
navigation.order: 4
icon: i-lucide-plug
---

The demo has a public docs MCP server. To edit the linked demo, use the hosted Console MCP:

| Server | Path | Sign-in | Tools |
| --- | --- | --- | --- |
| Docs | `/mcp` | None | `list-pages`, `get-page` |
| Console | `https://console.vitehub.dev/mcp/account` | Console OAuth | `list_apps`, `list_operations`, and `run_operation` for linked apps |

The docs server reads the published pages. The Console server sends signed requests as your Console user, subject to the demo’s authorization policy.

## Add the Console server

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    claude mcp add --transport http lumen-console https://console.vitehub.dev/mcp/account
    ```

    Run `/mcp` in Claude Code and select **Authenticate**. The browser opens the hosted Console sign-in page. Sign in with GitHub or a passkey and allow the client. The demo must be linked to your Console team.
  :::

  :::tabs-item{label="Codex" icon="i-simple-icons-openai"}
    ```toml [~/.codex/config.toml]
    [mcp_servers.lumen-console]
    url = "https://console.vitehub.dev/mcp/account"
    ```

    Run `codex mcp login lumen-console` and sign in in the browser.
  :::
::

## Edit a page from your agent

Ask your agent to find the demo with `list_apps`, inspect its Content operations with `list_operations`, and use `run_operation` to read and save a draft. Include the digest returned by the read when saving. Review and publish the draft in the Console.

::warning
`content.publish` publishes the drafts. A blog post or a release is live within a minute. Clients such as Claude Code ask before they run a tool with `destructiveHint`, but ViteHub cannot force them to ask.
::

::agent-only
`content.save` needs `ifDigest`: the digest that `content.show` returned for the current draft, or `null` for a new document. The document id of a page is its file path in `content/` without `.md`, such as `docs/guides/compress`.
::

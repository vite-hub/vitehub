---
title: Connect your agent
description: Add the Console MCP server of this site to Claude Code or Codex, sign in once, and let your agent read and edit pages.
navigation.order: 4
icon: i-lucide-plug
---

This site has two MCP servers:

| Server | Path | Sign-in | Tools |
| --- | --- | --- | --- |
| Docs | `/mcp` | None | `list-pages`, `get-page` |
| Console | `/_vitehub/mcp` | OAuth, as you | Every Console operation that your role allows, such as `content_show`, `content_save`, `content_publish`, and `comments_list_threads` |

The docs server reads the published pages. The Console server acts as you, with your CMS role.

## Add the Console server

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    claude mcp add --transport http lumen-console https://docs-demo.vitehub.dev/_vitehub/mcp
    ```

    Run `/mcp` in Claude Code and select **Authenticate**. The browser opens the sign-in page of this site, then asks you to allow the client.
  :::

  :::tabs-item{label="Codex" icon="i-simple-icons-openai"}
    ```toml [~/.codex/config.toml]
    [mcp_servers.lumen-console]
    url = "https://docs-demo.vitehub.dev/_vitehub/mcp"
    ```

    Run `codex mcp login lumen-console` and sign in in the browser.
  :::
::

## Edit a page from your agent

Ask your agent, for example: "Read /docs/guides/compress with content_show and add a sentence about AVIF to the first paragraph. Save it as a draft." The agent calls `content_show` to get the page and its digest, then `content_save` with that digest. The draft shows in the Console at once. Publish it yourself, or ask the agent to call `content_publish`.

::warning
`content_publish` publishes the drafts. A blog post or a release is live within a minute. Clients such as Claude Code ask before they run a tool with `destructiveHint`, but ViteHub cannot force them to ask.
::

::agent-only
`content_save` needs `ifDigest`: the digest that `content_show` returned for the current draft, or `null` for a new document. The document id of a page is its file path in `content/` without `.md`, such as `docs/guides/compress`.
::

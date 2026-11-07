---
title: Edit this site
description: How this demo works. Sign in, open the tools pill, edit a page in the Console, leave a comment, and let your coding agent edit pages through MCP.
navigation.title: Overview
layout: landing
---

This site is a Nuxt app on one Cloudflare Worker. The pages are Markdown files in [`packages/docs/playground`](https://github.com/vite-hub/vitehub/tree/main/packages/docs/playground) of vite-hub/vitehub. The blog posts, the changelog, and the authors are CMS documents. Editors change all of them in the ViteHub Console.

::illustration{name="edit-this-site" alt="A monitor with an editor and comment bubbles, two database cylinders, a media crate, and a plug for MCP."}
::

::product-features
  :::product-feature-item{title="The Console and the pill" icon="i-lucide-panels-top-left" to="/docs/this-site/console"}
  Sign in, open the tools pill on any page, and open the Console beside the page.
  :::

  :::product-feature-item{title="Edit and publish a page" icon="i-lucide-file-pen-line" to="/docs/this-site/edit-and-publish"}
  Change a page in the Content editor, check the draft in the preview, and publish it.
  :::

  :::product-feature-item{title="Leave a comment" icon="i-lucide-message-square-plus" to="/docs/this-site/comments"}
  Pin a comment to a part of a page, and resolve it in the Console.
  :::

  :::product-feature-item{title="Connect your agent" icon="i-lucide-plug" to="/docs/this-site/connect-your-agent"}
  Add the Console MCP server to Claude Code or Codex, and edit pages from your agent.
  :::

  :::product-feature-item{title="The docs assistant" icon="i-lucide-message-square-text" to="/docs/this-site/assistant"}
  Why this site has no Ask button, and where the assistant runs.
  :::
::

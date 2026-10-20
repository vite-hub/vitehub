---
title: Shell
navigation.title: Overview
description: Run shell commands from server code on files you choose, with limits on commands, output, and time.
navigation.order: 1
icon: i-lucide-terminal
---

::product-hero{tagline="Run simple shell commands like ls, cat, and rg from your server, with limits you control." hosts="Node, Docker, Cloudflare"}
  :::product-files
  ```ts [server/utils/docs-shell.ts]
  import { createShellRuntime } from 'vite-hub/shell'
  import {
    createJustBashProvider,
  } from 'vite-hub/shell/providers/just-bash'
  import {
    createReadonlyWorkspaceFs,
  } from 'vite-hub/shell/workspace'
  import { useWorkspace } from 'vite-hub/workspace'

  // A shell that can only read the docs Workspace
  export function docsShell() {
    const docs = useWorkspace('docs')
    return createShellRuntime({
      policy: { timeout: 10_000, maxOutputLength: 5_000 },
      // Bash in JavaScript: no real processes
      provider: createJustBashProvider({
        // The only commands it can run
        commands: ['ls', 'cat', 'rg'],
        fs: createReadonlyWorkspaceFs(docs.fs),
      }),
    })
  }
  ```

  ```ts [server/api/search.get.ts]
  import { defineEventHandler } from 'h3'
  import { docsShell } from '../utils/docs-shell'

  // Find every line that mentions "auth"
  export default defineEventHandler(async () => {
    const result = await docsShell().exec('rg auth .')

    // Exit code 0 means the command worked
    return {
      exitCode: result.exitCode,
      output: result.stdout,
    }
  })
  ```

  ```ts [server/api/overview.get.ts]
  import { defineEventHandler } from 'h3'
  import { docsShell } from '../utils/docs-shell'

  // A session shares one limit across commands
  export default defineEventHandler(async () => {
    const session = docsShell().createSession({
      policy: { maxShellCalls: 2 },
    })
    try {
      const files = await session.exec('ls')
      const intro = await session.exec('cat intro.md')
      return [files.stdout, intro.stdout]
    }
    finally {
      await session.dispose()
    }
  })
  ```

  ```ts [server/api/check.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { analyzeShellCommand } from 'vite-hub/shell'

  // Read what a command does before you run it
  export default defineEventHandler(async (event) => {
    type Body = { command: string }
    const body = await readBody<Body>(event)
    const facts = await analyzeShellCommand(body.command)

    // For example: { commands: ['rg'], ... }
    return {
      commands: facts.commands,
      hasPipelines: facts.hasPipelines,
    }
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Choose the allowed commands" icon="i-lucide-list-checks" to="/docs/shell/configure#providers"}
  List the commands a shell can run. Network access stays off unless you turn it on.
  :::

  :::product-feature-item{title="Work on your files" icon="i-lucide-folder-open" to="/docs/shell/server-api#workspace-filesystem"}
  Commands see the files of a [Workspace](/docs/workspace) under `/workspace`. You choose read-only or write access.
  :::

  :::product-feature-item{title="Clear results" icon="i-lucide-terminal" to="/docs/shell/server-api#shell-observation-shape"}
  Each command returns its exit code, output, and errors. A blocked command returns exit code `126`.
  :::

  :::product-feature-item{title="Limits across commands" icon="i-lucide-gauge" to="/docs/shell/server-api#use-shell-sessions"}
  A session shares one limit for calls, output size, and time across many commands.
  :::

  :::product-feature-item{title="Check a command first" icon="i-lucide-search" to="/docs/shell/server-api#analyze-commands"}
  `analyzeShellCommand()` lists the programs, pipes, and redirects in a command. You decide what to allow.
  :::

  :::product-feature-item{title="Stop slow commands" icon="i-lucide-timer" to="/docs/shell/configure#session-and-exec-options"}
  Set a timeout, or cancel a command with an `AbortSignal`.
  :::
::

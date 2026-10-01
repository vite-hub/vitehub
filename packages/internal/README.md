# @vite-hub/internal

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="Private" src="https://img.shields.io/badge/Private-not%20published-b91c1c?style=flat-square">
  <img alt="Internal" src="https://img.shields.io/badge/Internal-shared%20helpers-525252?style=flat-square">
</p>

`@vite-hub/internal` is a private workspace package for shared implementation code. Application code should not import it.

## Install

Do not install this package directly. Other ViteHub packages depend on it inside the monorepo.

## Minimal API

```ts
// packages/*/src/internal-use.ts
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { createNoExternalAddition } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { summarizeDefinitions } from "@vite-hub/internal/inspect"
import { readViteHubConsoleSection } from "@vite-hub/internal/console"
import { discoverViteHubDevServer } from "@vite-hub/internal/cli"
import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
```

## Used by

Packages use it for definition discovery, generated runtime registries, Provider Output, hosted runtime helpers, and hosting normalization.

Owner packages expose inspection data through `vitehub.inspect` on their Vite plugin. The contributor returns `definitions` inspectors and `providerOutput` entries from `@vite-hub/internal/inspect`. `vitehub inspect` and the Console render that data. They do not own it.

Owner packages contribute Console sections with `ViteHubConsoleSectionContribution` from `@vite-hub/internal/console`. A contribution has an `id`, a `label`, an Iconify `icon`, a `description`, a `read` function that runs on the server, and a `view`. The view is a `definition-catalog` (Definitions in a sidebar with a detail panel) or a `record-table` (records in a table with a detail panel), and it has a `notice` that states which runtime data the section does not include. The Vue UI stays in `vite-hub`. For example, `@vite-hub/queue/vite` exports `queueConsoleSection`, and its `read` is `inspectQueueDefinitions`, so the Console and `vitehub inspect definitions` show the same Definitions. Record values are display strings. Do not put credentials in records.

Runtime commands such as `vitehub agent dev` and `vitehub workspace dev` target a running Vite Development Server with `@vite-hub/internal/cli`: `readViteHubDevTargetOption` reads `--url`, `--server` and `--timeout`, `discoverViteHubDevServer` calls the discovery `GET`, and `fetchViteHubDevEndpoint` adds the guard header. The owner package registers the matching endpoint with `registerViteHubDevEndpoint` from `@vite-hub/internal/dev-endpoint`. It checks the `Host` header, the guard header, the request origin, and the JSON content type before the owner handler runs. The `Host` check uses Vite's host validation rules (`localhost`, IP literals, `server.host`, and `server.allowedHosts`). It blocks DNS rebinding, where a page on another host name resolves to the dev server and sends a matching `Origin`.

These helpers are dev-only. Dev endpoints trust the `Host` header, the guard header, the request origin, and a token file under the project root. A deployed stage has none of these, and no existing authenticated path reaches these endpoints on a deployed stage. Commands that target a deployed stage, such as `vitehub channels sync --stage <name> --url <origin>`, load the stage environment and call the provider APIs with its credentials.

Learn more at [vitehub.dev](https://vitehub.dev).

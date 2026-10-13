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

Source readers use `createSourceScanner(file)` from `@vite-hub/internal/source-scanner` to bind the file grammar. Its matching, splitting, object, and comment readers keep that grammar for source fragments. The standalone readers use JavaScript and TypeScript grammar without JSX. Filenames that end in `.jsx` or `.tsx` enable JSX, with TypeScript generic heads recognized only for `.tsx`.

## Used by

Packages use it for definition discovery, generated runtime registries, Provider Output, hosted runtime helpers, and hosting normalization.

Owner packages expose inspection data through `vitehub.inspect` on their Vite plugin. The contributor returns `definitions` inspectors and `providerOutput` entries from `@vite-hub/internal/inspect`. `vitehub inspect` and the Console render that data. They do not own it.

Owner packages contribute Console sections with `ViteHubConsoleSectionContribution` from `@vite-hub/internal/console`. A contribution has an `id`, a `label`, an Iconify `icon`, a `description`, a `read` function that runs on the server, and a `view`. The view is a `definition-catalog` (Definitions in a sidebar with a detail panel) or a `record-table` (records in a table with a detail panel), and it has a `notice` that states which runtime data the section does not include. The Vue UI stays in `vite-hub`. For example, `@vite-hub/queue/vite` exports `queueConsoleSection`, and its `read` is `inspectQueueDefinitions`, so the Console and `vitehub inspect definitions` show the same Definitions. Record values are display strings. Do not put credentials in records.

A `record-table` section can also read records at request time. Add `runtime: { module, export }`, where `module` is an owner package path such as `@vite-hub/schedule/runtime/console` and `export` names a function that returns `ViteHubConsoleRecord[]` in the server runtime. `read` is then optional and returns the build-time records. The host imports the reader in its generated server code and calls it on each Console request, after the build-time records. A runtime record replaces a build-time record with the same id. `describeViteHubConsoleRuntimeReader` returns the checked reader, and `isViteHubConsoleRuntimeSection` tells the two record-table forms apart.

Runtime commands such as `vitehub agent dev` and `vitehub workspace dev` target a running Vite Development Server with `@vite-hub/internal/cli`: `readViteHubDevTargetOption` reads `--url`, `--server` and `--timeout`, `discoverViteHubDevServer` calls the discovery `GET`, and `fetchViteHubDevEndpoint` adds the guard header. The owner package registers the matching endpoint with `registerViteHubDevEndpoint` from `@vite-hub/internal/dev-endpoint`. It checks the `Host` header, the guard header, the request origin, and the JSON content type before the owner handler runs. The `Host` check uses Vite's host validation rules (`localhost`, IP literals, `server.host`, and `server.allowedHosts`). It blocks DNS rebinding, where a page on another host name resolves to the dev server and sends a matching `Origin`. An optional `authorize` callback runs owner authorization, for example a dev token check, after the guard checks. The handler receives a `ViteHubDevRequestGrant` for the request only after that check passes. A grant is frozen, bound to its request object, and valid only for that request. Only the checks in this module create grants. An operation that needs a checked request takes the grant and calls `assertViteHubDevRequestGrant(grant, request)`, which throws for a missing, forged, or other-request grant. Compare dev tokens and other request secrets with `isViteHubSecretEqual` from `@vite-hub/internal/secret`. Use `isViteHubBearerSecretEqual` for a `Bearer` `Authorization` header. Both compare in constant time and use no Node API, so they also run in Worker runtimes. Production routes use the same functions.

Some operations must run in the Nitro runtime, because the Nitro runtime owns the stores and registries. For these operations, `registerViteHubNitroDevEndpoint` registers the same guarded endpoint and forwards each `POST` with `forwardViteHubDevRequestToNitro`. The helper finds `server.environments.nitro` with `findViteHubNitroDevEnvironment`, calls the owner route under the Nitro `baseURL` (`viteHubNitroRuntimeRoute`), and adds the guard header. It requires the grant of the Vite guard check, because the forwarded request carries the guard header and the trusted `runtimeHeaders`. The discovery `GET` returns `runtime: "nitro"` or `runtime: "unavailable"`. When the Vite process has no Nitro environment, the `POST` returns `501` with a clear message. The owner package adds a `serve`-only Nitro handler whose source comes from `renderViteHubNitroDevHandler`. The handler calls an owner runtime export, and that export checks the request again with `validateViteHubNitroDevRequest`. That check returns `{ grant }` or `{ rejection }`. Its optional `authorize` callback runs owner authorization, for example a dev token check, before the grant exists. The export runs the operation only with the grant. The Nitro route is also reachable over HTTP on the dev server, and the Nitro runtime does not know `server.allowedHosts`. The Nitro check therefore accepts only the host names that the forwarder uses: `localhost`, `*.localhost`, and IP literals. It blocks DNS rebinding on the Nitro route.

Only Vite + Nitro hosts run Nitro in the Vite process. Nuxt runs Vite in middleware mode under its `buildAssetsDir` and runs Nitro in a separate dev worker, so the Vite middleware cannot dispatch into Nitro, and requests to the root dev endpoint do not reach the Vite middleware. Plain Vite has no Nitro. These hosts get the `501` response.

These helpers are dev-only. Dev endpoints trust the `Host` header, the guard header, the request origin, and a token file under the project root. A deployed stage has none of these, and no existing authenticated path reaches these endpoints on a deployed stage. Commands that target a deployed stage, such as `vitehub channels sync --stage <name> --url <origin>`, load the stage environment and call the provider APIs with its credentials.

Learn more at [vitehub.dev](https://vitehub.dev).

# @vite-hub/console-client

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fconsole-client&icon=npm)](https://npmx.dev/package/@vite-hub/console-client)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs/development/console)

`@vite-hub/console-client` is the prebuilt ViteHub Console app: its script, styles, fonts, and page tool. `vite-hub` serves it at `/_vitehub` when the app turns the [Console](https://vitehub.dev/docs/development/console) on. It is an optional peer of `vite-hub`, so an app without the Console does not install it.

```sh
pnpm add @vite-hub/console-client
```

`vitehub add console` adds it for you. When the Console is on and this package is missing, the build stops and prints the install command.

The package has no JavaScript API. `@vite-hub/console-client/manifest.json` names the hashed entry files in `dist/client`.

The `vite-hub` build writes this package from the Console sources in `packages/vite-hub/src/console`, with `console.vite.config.ts` and `page-tool.vite.config.ts`. Build it with `vp run -t vite-hub#build`.

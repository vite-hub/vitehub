# ViteHub i18n: storage design (draft for review)

Status on branch `feat/i18n` (2 commits, not pushed as a PR):

- `t` and `<Trans>` in Vue templates with no import, and `t`, `plural`, `select`, `msg` imported from `vite-hub/i18n` in scripts and server code.
- The build compiles each message to a 6-character ID (a hash of the English text and its context). App code ships no English text.
- Each request has its own locale on Nitro 3: cookie, then `Accept-Language`, then the source locale. A test sends 40 concurrent mixed requests.
- Nuxt 4 (Nitro 2) fails with `I18N_UNSUPPORTED_HOST`. Nuxt 5 is not wired yet.
- Today the translations are `locales/<locale>.po` files in the repository, written by `vitehub i18n extract`.

This document proposes to move the translations out of the code, the same way as Content.

## 1. Source messages come from the build, not from a file

The build already reads every message. It writes a manifest of the source messages:

```json
{ "4cGun4": { "message": "Hello <0>{name}</0>, read the <1>docs</1>.", "context": null, "origins": ["app/pages/index.vue:8"] } }
```

- The key is the ID, so the key is the English text. When the English changes, the ID changes.
- The manifest is build output in `.vitehub/i18n/manifest.json`. Nobody edits it, and git does not track it.
- The server and the client get the source text from the manifest, so a missing translation shows English, never an ID.
- `vitehub i18n extract` is gone. `vitehub i18n status` compares the manifest with the stored translations.

## 2. Translations live in a Workspace, like Content documents

A Workspace named `i18n` holds one record per locale and message ID:

```text
es/4c/4cGun4.json
```

```json
{
  "source": "Hello <0>{name}</0>, read the <1>docs</1>.",
  "translation": "Hola <0>{name}</0>, lee la <1>documentación</1>.",
  "review": "verified",
  "updatedAt": "2026-11-06T12:00:00Z",
  "by": "ana"
}
```

- `review` is `machine`, `edited`, or `verified`.
- The store is the same choice as Content: a local folder in development (it can be a Git checkout, so translations can still live in the repo), GitHub, or Blob + Database for a shared store that people and Agents edit without a deploy.
- Like Content, writes go to the `draft` ref and readers see `published`. The Console and the Agent Capability publish exact digests.

## 3. Smart reuse, like diglot

- **Same text, one translation.** Two places with the same English share one ID and one record.
- **Markup is not text.** `<0>docs</0>` hides the `href` and the component, so a new link or class keeps the translation.
- **Lineage.** When a message at the same origin changes its English, the build sees the old ID disappear and a new one appear. The new record starts as `machine` from the old translation and keeps `previous: { source, translation }`. A translator or an Agent updates it with a small change instead of a new translation.
- **Unused records.** `vitehub i18n status` lists records whose ID no manifest uses. `vitehub i18n prune` deletes them after confirmation.

## 4. Runtime and caching

- The server reads the `published` records once per Workspace revision and compiles one catalog per locale. It keeps the catalogs in memory and keys them by the revision ID.
- The client gets `/_vitehub/i18n/<locale>.<revision>.json` with `Cache-Control: immutable`. A publish changes the revision, so browsers fetch the new catalog and nothing else.
- A published translation is live without a deploy.
- The build can also embed a snapshot of the published catalogs, so the first request does not wait on the store. The revision check then replaces it.

## 5. Translation work

- `vitehub i18n translate [--locale es]` translates missing and stale records with the app's model as `machine` drafts.
- An `i18n()` Agent Capability lists missing messages, saves drafts, and publishes with approval, like `content()`.
- A Console section shows coverage per locale and edits records.
- `vitehub i18n export --format po` and `import` keep a path for translators who use Poedit or a TMS.

## Decisions for Maxi

1. **Record layout.** One file per locale and ID (diglot, shown above): clean diffs, no merge conflicts, review state per message. The other option is one `es.json` per locale: fewer reads, but every edit touches one big file. Recommendation: one file per ID, with the compiled catalog cached by revision.
2. **Default store.** Development: a local `locales/` folder in the project (a Git checkout, so translations still show in PRs). Production: the store that the app configures, like Content. Without one, the build snapshot is used and the app does not get live updates. Recommendation: yes.
3. **Build snapshot.** Embed the published catalogs in the build, as a fallback when the store is slow or down. Recommendation: yes.

## Units, each with its own check

1. Build manifest from the module graph. Check: manifest equals the messages of the fixture app, with origins.
2. Workspace record store, `draft` and `published`. Check: save, publish, read back on the local store and the Blob + Database store.
3. Runtime catalogs keyed by revision, plus the client route. Check: publish a translation in the built app and see it in the next response without a rebuild, and get one `200`, then a cached response, per revision.
4. Lineage on English changes. Check: change one English message, rebuild, and get a `machine` record with `previous`.
5. Nuxt 5 runtime plugin (per-request Vue plugin, hydration of the locale). Check: Nuxt 5 nightly SSR plus a browser check of `setLocale()`.
6. CLI `status`, `translate`, `export`/`import`, Agent Capability, Console section, docs. Checks: the CLI tests and the docs gates.

---
title: Edit Content in the Console
description: Edit, publish, and restore Content documents from the ViteHub Console, and give editors access to only that section.
navigation.title: Console editor
navigation.order: 5
icon: i-lucide-file-pen-line
---

The Console has a Content section for the [document collections](/docs/content/configure#document-collections) of `server/content.ts`. Editors open `/_vitehub/content`. Your public site needs no edit button or overlay.

The section appears when `server/content.ts` passes `collections` to `defineContent()`. A Content file with only read-only Sources has nothing to edit, so the Console leaves the section out. Discovery reads the file without running it: when it cannot follow the collections, such as an object imported from another file, it keeps the section and the editor lists what the runtime defines. The section lists every collection that the signed-in user may read.

## What editors can do

| Task | How |
| --- | --- |
| Find a document | Search, filter by state (draft, changed, published, deleted), filter by enum, boolean, and tag fields, and sort by title or the first date field. **Updated** shows when each document last changed; hover it for the exact time. |
| Edit fields | A form built from the collection's [JSON Schema](/docs/content/configure#fields). |
| Edit the body | A Markdown editor with a Rich mode and a Source mode. Both write the same Markdown. |
| Save | **Save** or <kbd>⌘</kbd> <kbd>S</kbd> commits the document to the `draft` ref. |
| Publish | **Publish** on a document, **Publish N changes** on a collection, or select documents and publish only those. |
| Undo a change | **History** lists the saves and publishes of a document. Open one to compare its stored file with the saved draft, then restore it as a new draft. A version that no longer validates still opens. |
| Create and delete | **New** opens an empty document whose id follows the title. **Delete** removes the document from the draft. It stays published until you publish the deletion. |

## Fields in the form

The form reads each field's JSON Schema:

| Schema | Input |
| --- | --- |
| `string` | Text input. A `maxLength` over 200 gets a text area. The `title` field (or `name`, `label`, `heading`) sits above the body. |
| `string` with `format: 'date'` | Date picker, stored as `YYYY-MM-DD`. |
| `string` with `format: 'date-time'` | Date and time pickers in UTC, stored as an ISO string. Zod date fields such as `z.coerce.date()` use this. |
| `enum` | Select. |
| `number`, `integer` | Number input with `minimum` and `maximum`. |
| `boolean` | Switch. |
| `array` of strings | Tag input. |
| `object` with `properties` | A group of nested fields. |
| A Blob reference (`x-vitehub-blob`) | The stored pathname, read-only. Choosing media from the Console is not available yet. |
| Anything else | A JSON text area. |

A field without a Standard JSON Schema, such as a Valibot validator, has the schema `{}` and gets the JSON text area. Optional fields left empty are removed before the save, so an empty input never saves `""` over a missing value.

## Saves never overwrite newer work

Each save sends the digest of the version the editor opened. When someone else saved the document in the meantime, Content returns `WORKSPACE_CONFLICT` and the editor compares the two versions. Choose **Overwrite with mine** to save over the version you just compared, or **Discard mine, load theirs**. **Keep editing** closes the comparison and keeps your changes in the editor.

When a field does not validate, Content returns `CONTENT_INVALID` with one issue per field. The editor shows each message next to its field and saves nothing.

## Publishing publishes what you reviewed

Every publish names the documents and the draft digests that the editor showed, through [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed). **Publish** on a document sends the draft on screen. **Publish N changes** and **Publish N selected** send the drafts the list loaded.

When someone saved one of those drafts after it loaded, Content publishes nothing and returns `WORKSPACE_CONFLICT` with the documents that changed. The list names them: choose **Refresh** to load the latest drafts, review them, and publish again. The document editor loads the newer draft for you.

When a draft no longer validates, for example after a field changed in `server/content.ts`, publishing returns `CONTENT_INVALID` for that document and publishes nothing. The list names the document, and the editor highlights its fields. Fix them, save, and publish again.

## Give editors only the Content section

Two policies decide what an editor can do:

1. [`console.authorize`](/docs/development/console#limit-a-user-to-some-sections) decides which Console sections a request may use. Return `{ sections: ['content'] }` for editors.
2. [`authorize` in `defineContent()`](/docs/content/configure#access) decides what a user may do with each collection. The Console calls `content.can()` with the signed-in user before every read, save, delete, restore, and publish.

```ts [vite.config.ts]
vitehub({
  preset: 'node',
  auth: true,
  database: true,
  workspace: true,
  console: { auth: 'app', authorize: './server/console-authorize.ts' },
})
```

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
  if (user?.role === 'admin') return true
  if (user?.role === 'editor' || user?.role === 'writer') return { sections: ['content'] }
  return false
})
```

```ts [server/content.ts]
export const content = defineContent({
  workspace: 'site',
  collections: { posts },
  // Writers save drafts. Only editors publish.
  authorize: ({ user, action }) => {
    if (user?.role === 'editor') return true
    if (user?.role === 'writer') return action !== 'publish'
    return false
  },
})
```

A writer sees the posts, saves drafts, and gets no publish buttons. A publish request from a writer returns `403` with `CONTENT_FORBIDDEN`. Any other Console section returns `403`, and the navigation shows only Content.

The Console passes the user that the Console access mode signed in:

| `console.auth` | `user` in `content.can()` |
| --- | --- |
| `'app'` or a session-based Console Auth | The signed-in user. |
| `false` | `null`. Use `console.authorize` to decide who reaches the section, and let `content.authorize` allow `null` only if every such request may edit. |
| Cloudflare Access | `null`. |

Saves, restores, deletes, and publishes record the user's `name`, `email`, or `id` as the revision author. History shows it.

## Playground

`playground/content` in the ViteHub repository is a complete app with app Auth, the Blob + Database Store, two collections, and three users: an admin, an editor limited to Content, and a writer who cannot publish. See its README to run it.

## Limits

- The section loads `server/content.ts` on the first Content request, not at server start.
- Document requests accept bodies up to 1 MiB.
- The list reads every document of the collection in memory, the same as [`list()`](/docs/content/server-api).
- History shows the last 20 saves and the last 20 publishes of a document, then older saves on request. Content scans at most 1,000 revisions per page.
- Media upload, a media library, and a live preview of the page are not available yet.
- The Nuxt module registers the page, but this editor has been verified only in the Vite Console. Nuxt hosts need `comark` and `comark-tiptap` installed.

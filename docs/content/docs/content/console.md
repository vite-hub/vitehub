---
title: Edit Content in the Console
description: Edit, publish, and restore Content documents from the ViteHub Console, and give editors access to only that section.
navigation.title: Console editor
navigation.order: 5
icon: i-lucide-file-pen-line
---

The Console has a Content section for the [document collections](/docs/content/configure#document-collections) of `server/content.ts`. Editors open `/_vitehub/content`. Your public site needs no edit button or overlay.

The section appears when `server/content.ts` passes `collections` to `defineContent()`. A Content file with only read-only Sources has nothing to edit, so the Console leaves the section out. Discovery reads the file without running it: when it cannot follow the collections, such as an object imported from another file, it keeps the section and the editor lists what the runtime defines. The section lists every collection that the signed-in user may read.

## Find your way around

`/_vitehub/content` opens the dashboard:

- Counts of drafts, changed, published, and deleted documents across the collections you may read.
- **Needs publishing** lists every unpublished change, newest first. **Publish** in the header publishes all of them, exactly as the dashboard shows them. Writers see the list without the button.
- **Recent activity** names who saved, deleted, restored, or published which document, and when.
- **Collections** lists each collection with a **New** button when you may edit it.

The sidebar lists the dashboard, every collection with its draft and changed counts, **Settings** when you define a [singleton](/docs/content/configure#singletons-and-data-files), and Media when the project enables Blob. Settings lists each singleton, such as site settings, with its state, and opens it in the editor; singletons do not appear among the collections. Media links to the Blob section for now; it does not upload or describe files yet. Each page has a URL, such as `/_vitehub/content/-/media`. See [Section pages and URLs](/docs/development/console#section-pages-and-urls).

<kbd>⌘</kbd> <kbd>K</kbd> searches the drafts of every collection by title, id, fields, and body. <kbd>Enter</kbd> opens a document, and <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. The same search creates documents and reviews and publishes all changes. See [Search](/docs/development/console#search).

## What editors can do

| Task | How |
| --- | --- |
| Find a document | Search, filter by state (draft, changed, published, deleted), filter by enum, boolean, and tag fields, and sort by title or the first date field. **Updated** shows when each document last changed; hover it for the exact time. |
| Edit fields | Property rows under the title, built from the collection's [JSON Schema](/docs/content/configure#fields). Empty optional fields fold behind **Show N more**. JSON and YAML documents have no body, so their property rows are the page and show every field. |
| Edit the body | A block editor over the Markdown. Select text for formatting, type <kbd>/</kbd> to insert blocks, images, and the collection's [components](/docs/content/configure#define-collections), and hover a block for ⋮⋮ (move, turn into, duplicate, copy link, delete) and + (insert below). |
| Edit settings | Open **Settings** in the sidebar, or search for the singleton with <kbd>⌘</kbd> <kbd>K</kbd>. A [singleton](/docs/content/configure#singletons-and-data-files), such as `settings`, opens straight into its editor, without a list. Before its first save it shows the field defaults, and the first edit saves it. It cannot be deleted from the Console. |
| See the file | **Source** (<kbd>⌘</kbd> <kbd>/</kbd>) shows the stored file: the frontmatter read-only and the Markdown body editable. |
| Save | Drafts save one second after typing stops. <kbd>⌘</kbd> <kbd>S</kbd> saves at once. A new document saves when you choose **Create**, since its id names the file. |
| Publish | **Publish** on a document, **Publish N changes** on a collection, **Publish** on the dashboard for every collection, or select documents and publish only those. |
| Undo a change | **History** lists the saves and publishes of a document. Saves in a row by one person show as one entry, such as **Saved · 12 edits**, and expand to each save. Open one to compare its stored file with the saved draft, then restore it as a new draft. A version that no longer validates still opens. On wide screens the side panel shows History or the body's outline. |
| Create and delete | **New** starts at the title. The id follows the title until you edit it. **Delete** removes the document from the draft. It stays published until you publish the deletion. |

## Fields as properties

Each field is a row that reads its JSON Schema:

| Schema | Input |
| --- | --- |
| `string` | Text input. A `maxLength` over 200 gets a text area, where <kbd>⌘</kbd> <kbd>Enter</kbd> saves. The `title` field (or `name`, `label`, `heading`) is the page title above the properties. |
| `string` with `format: 'date'` | Date field with a calendar, stored as `YYYY-MM-DD`. |
| `string` with `format: 'date-time'` | Date and time fields in UTC, stored as an ISO string. Zod date fields such as `z.coerce.date()` use this. |
| `enum` | Select. |
| `number`, `integer` | Number input with `minimum` and `maximum`. |
| `boolean` | Switch. |
| `array` of strings | Tag input. |
| `object` with `properties` | A one-line summary that expands to the nested fields. |
| A Blob reference (`x-vitehub-blob`) | The stored pathname, read-only. Choosing media from the Console is not available yet. |
| Anything else | A JSON text area. |

A field without a Standard JSON Schema, such as a Valibot validator, has the schema `{}` and gets the JSON text area. Optional fields left empty are removed before the save, so an empty input never saves `""` over a missing value.

## Saves never overwrite newer work

Each save sends the digest of the version the editor opened. When someone else saved the document in the meantime, Content returns `WORKSPACE_CONFLICT`. Saving pauses, the header reads **Not saved · newer version**, and a toast offers **Compare**. The comparison shows both versions: choose **Overwrite with mine** to save over the version you just compared, or **Load theirs**. **Keep editing** closes it and keeps your changes in the editor, still unsaved.

When a field does not validate, Content returns `CONTENT_INVALID` with one issue per field. The editor shows each message next to its field and saves nothing. A save that runs on its own never moves focus; the header links to the first invalid field.

## The body round-trips

The body is Markdown, and the rich editor edits it through Comark. Opening a document and switching between Rich and Source writes nothing: the stored text stays byte for byte until someone edits it. After an edit the editor writes canonical Markdown, so formatting choices such as `*` bullets may become `-`.

When a body uses Markdown that the rich editor would drop, such as a component that the collection does not declare, Rich mode is read-only for that document and says so. Edit it in Source, or declare the component in `documents({ components })`.

Images inserted from the `/` menu, or pasted and dropped into the body, ask for a Blob path or URL and write it to the Markdown as is. The title is the page's heading, so start the body with its first paragraph rather than a `# Title` that repeats it.

## Publishing publishes what you reviewed

Every publish names the documents and the draft digests that the editor showed, through [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed). **Publish** on a document saves any pending edits first, then sends the draft on screen. **Publish N changes** and **Publish N selected** send the drafts the list loaded.

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
- The list reads every document of the collection in memory, the same as [`list()`](/docs/content/server-api). The dashboard and search read each collection's state once per request in the same way.
- Recent activity shows the last 20 revisions. Content scans at most 1,000 revisions of each ref to find them.
- Publishing from the dashboard or search publishes one collection at a time. When a draft moved after the page loaded, that collection publishes nothing and the Console asks you to refresh.
- History shows the last 20 saves and the last 20 publishes of a document, then older saves on request. Content scans at most 1,000 revisions per page.
- Media upload, a media library, and a live preview of the page are not available yet.
- Drafts save on their own only after a document exists. Leaving the page right after typing saves first; closing the tab asks.
- The Nuxt module registers the page, but this editor has been verified only in the Vite Console. Nuxt hosts need `comark` and `comark-tiptap` installed.

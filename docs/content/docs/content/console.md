---
title: Edit Content in the Console
description: Edit, publish, and restore Content documents from the ViteHub Console, and give editors access to only that section.
navigation.title: Console editor
navigation.order: 9
icon: i-lucide-file-pen-line
---

The Content section of the [Console](/docs/development/console) edits the [collections](/docs/content/configure#document-collections) of `server/content.ts`. Your public site needs no edit button or overlay.

The section appears when `defineContent()` has `collections`, not with only read-only Sources. Discovery reads the file without running it. If it cannot follow the collections, such as an object imported from another file, it keeps the section and lists what the runtime defines. It shows every collection the signed-in user may read.

## Find your way around

The section opens on the dashboard:

- Counts of draft, changed, published, and deleted documents in the collections you may read.
- **Needs publishing** lists each unpublished change, newest first. **Publish** in the header publishes all of them, exactly as shown. Writers see the list without the button.
- **Scheduled** lists [scheduled publishes](/docs/content/scheduling), soonest first, if any.
- **Recent activity** shows who saved, deleted, restored, or published which document, and when. It shows the latest eight. **Show all** shows the rest.
- **Collections** lists each collection with its draft, changed, and published counts, and **New** when you may edit it. A last **Settings** row counts the singletons and opens the Settings page.

The sidebar lists the dashboard, each collection with its draft and changed counts, and **Settings** and **Media** under **Manage**. **Settings** appears when you define a [singleton](/docs/content/configure#singletons-and-data-files), and lists each one with its state. Singletons are not listed with the collections. Lists name a singleton by its `label`, not its file name. **Media** appears when Blob is on and opens the [media library](#media-library).

When the app lacks something a feature needs, the Console shows the fix in its place:

- Without [`authorize`](/docs/content/configure#access) in `defineContent()`, nobody can read documents. The sidebar and dashboard ask you to add it.
- Without a Schedule Definition that calls [`content.publishDue()`](/docs/content/scheduling#run-due-schedules), **Schedule…** is off, and an **Overdue** schedule shows the fix.

<kbd>⌘</kbd> <kbd>K</kbd> searches all drafts by title, id, fields, and body. <kbd>Enter</kbd> opens a document. <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. Search also creates documents and reviews and publishes all changes.

## What editors can do

| Task | How |
| --- | --- |
| Find a document | Search, filter by state (draft, changed, published, deleted) or by enum, boolean, and tag fields, and sort by title or the first date field. **Updated** shows the last change. Hover it for the exact time. |
| Edit fields | Property rows under the title, from the collection's [JSON Schema](/docs/content/configure#fields). Empty optional fields fold behind **Show N more**. JSON and YAML documents have no body, so their rows fill the page and show every field. |
| Edit the body | A block editor over the Markdown. Select text to format it. Type <kbd>/</kbd> to insert blocks, images, and the collection's [components](/docs/content/configure#define-collections). Hover a block for ⋮⋮ (move, turn into, duplicate, copy link, delete) and + (insert below). |
| Edit SEO | A [`seo()` field](/docs/content/seo#seo-fields) adds an **SEO** group with counters, fallbacks, previews, and **Hide from search**. See [SEO](/docs/content/seo#console). |
| Edit settings | Open **Settings**, or find the singleton with <kbd>⌘</kbd> <kbd>K</kbd>. It opens straight into its editor with field defaults until the first edit saves it. The Console cannot delete it. |
| See the file | **Source** (<kbd>⌘</kbd> <kbd>/</kbd>) shows the stored file, with read-only frontmatter and an editable body. |
| Save | Drafts save one second after typing stops. <kbd>⌘</kbd> <kbd>S</kbd> saves at once. A new document saves on **Create**, because its id names the file. |
| Publish | **Publish** on a document, **Publish N changes** on a collection, **Publish** on the dashboard for all collections, or select documents and publish those. |
| Schedule | The arrow next to **Publish** opens **Schedule…**. The on-screen draft publishes at the date and time you pick. If you save again before then, the schedule fails, so unreviewed changes never publish. See [Scheduling](/docs/content/scheduling#console). |
| Undo a change | **History** lists a document's saves and publishes. One person's saves in a row show as one entry, such as **Saved · 12 edits**, that expands. Open one to compare it with the saved draft, then restore it as a new draft. Invalid versions still open. On wide screens, the side panel shows History or the body's outline. |
| Create and delete | **New** starts at the title. The id follows the title until you edit it. **Delete** removes the document from the draft. It stays published until you publish the deletion. |

## Fields as properties

Each field is a row built from its JSON Schema:

| Schema | Input |
| --- | --- |
| `string` | Text input. A `maxLength` over 200 gets a text area, where <kbd>⌘</kbd> <kbd>Enter</kbd> saves. The `title` field (or `name`, `label`, `heading`) is the page title above the rows. |
| `string` with `format: 'date'` | Date field with a calendar, stored as `YYYY-MM-DD`. |
| `string` with `format: 'date-time'` | Date and time fields in UTC, stored as an ISO string. Zod date fields such as `z.coerce.date()` use this. |
| `enum` | Select. |
| `number`, `integer` | Number input with `minimum` and `maximum`. |
| `boolean` | Switch. |
| `array` of strings | Tag input. |
| `array` of any other shape, such as objects or dates | A list with one row per item. An object item shows its `label`, `title`, or `name` and opens to its fields. Rows move up, move down, or are removed. **Add item** adds one. |
| `object` with `properties` | A one-line summary of the filled fields, such as **Label** Book a demo **To** /demo, that expands to the nested fields. |
| `object` with `src` and `alt` strings | An image. The summary shows a thumbnail and alt text, and the expanded fields a preview. The Console loads `src` from its own origin, so images on another origin show an icon. |
| A Blob reference (`x-vitehub-blob`), such as `image()` or `file()` | A thumbnail and file name with **Replace** and **Remove**, which open the [media picker](#pick-media-for-documents). An image also shows its alt text, which edits the alt text stored with the file. Without Blob, the pathname shows read-only. |
| Anything else | A JSON text area. |

A field without a Standard JSON Schema, such as a Valibot validator, has the schema `{}` and gets the JSON text area. So does a list of objects without `properties`. Empty optional fields are removed before the save, also in list items, so an empty input never saves `""` over a missing value.

## Saves never overwrite newer work

Each save sends the digest of the version you opened. If someone else saved in the meantime, Content returns `WORKSPACE_CONFLICT`. Saving pauses, the header reads **Not saved · newer version**, and a toast offers **Compare**. The comparison shows both versions. Choose **Overwrite with mine** to save over the version you compared, or **Load theirs**. **Keep editing** closes it and keeps your unsaved changes.

An invalid field still saves, so you lose nothing. The editor shows each message next to its field, and the header links to the first one. **Publish** stays off with "Fix 2 fields to publish" until they validate. The list and dashboard show the issue count, and **Publish all** leaves these drafts out.

## Editing together

The Console shows who has a document open, and gives one tab at a time the [edit lease](/docs/content/editing-together). It needs `contentSessionsSchema` in the Workspace history Database. [Live editing](/docs/content/editing-together#live-editing) with Realtime needed the Console that the app served, which is removed.

- **Avatars.** The header shows up to three people, then `+N`. Hover one for `Ana · Editing` or `Ana · Viewing`. List rows show one small avatar, such as `Ana is editing`. The dashboard lists them under **Open now**.
- **First edit.** Opening does not lock a document. The first keystroke claims the lease, and the edit stays on screen meanwhile. Saving starts once this tab holds it.
- **Someone else is editing.** The dialog says `Ana is editing this page`, with **Open read-only** and **Take over**. <kbd>Esc</kbd> opens it read-only. People without write access never see **Take over**.
- **Read-only.** A line above the title says `Read-only · Ana is editing`, with **Take over**. When Ana leaves, it says `Ana stopped editing`, with **Reload and edit**.
- **Taken over.** The former editor sees `Ben took over · Your changes up to 10:42 are saved`, with **Compare** and **Take back**. Edits that could not save show as `1 edit wasn't saved`, with **Copy**.
- **Another tab of yours.** A second tab says `You're editing this in another tab` and offers the same choices.
- **Updates.** A page without unsaved edits reloads when someone else saves. A page with unsaved edits keeps them, and the next save shows the comparison.
- **Unreachable.** If the Console cannot check sessions, the header says `Can't check who else is editing` and the page stays editable. Saves still refuse to overwrite a newer version.

The editor reports every 15 seconds, or 60 while hidden. After 15 minutes without input, the tab frees the lease, and the next keystroke claims it again if free. Closing the tab frees it at once.

## Preview the page

Select the **Open the preview in a new tab** button in the editor header. A new tab opens the page of the document on your app, with its saved draft. The rest of the page shows published content. Edits that are not saved yet do not show, so wait for the draft to save first.

The button needs `url` on the collection, so the document has a page. The Console asks your app for a [one-time link](/docs/development/console#one-time-links), and the app checks that you may read the document. Your app renders the draft with the [preview frame](/docs/content/preview) of `server/content.ts`.

The side browser with **Draft** and **Published** views, and click to edit, needed the Console that the app served, which is removed.

## Translations

A collection with [`locales`](/docs/content/configure#locales) shows the locales next to the title, source locale first, such as `EN ES`. A dot gives the state of each translation: green when it is up to date, yellow when the source changed after it, and empty when it is not translated yet. Hover a locale for its name and state. List rows name the translations that need work, such as `ES out of date` or `ES missing`.

- **Not translated yet.** The locale opens with the source version and says so. Your first edit saves the translation in its own file, such as `docs/es/guide.md`, and records the source version on screen. If someone changed the source in the meantime, the translation shows as out of date at once.
- **Out of date.** A line above the title says the source changed after the translation, with a button that opens the source. Saves keep the translation out of date, so a typo fix does not hide a change in the source.
- **Mark as up to date.** The button on that line shows the current source version. Confirm, and the save records that version as the source of the translation. If the source changed again while you checked it, the dialog shows the newer version and the translation stays out of date.
- **Publish.** **Publish** publishes the translation on screen. **Schedule…** stays on the source locale.
- **Not yet for translations.** The edit lease and Local only work on the source locale. Saves of a translation still refuse to overwrite a newer version.

## Edit locally first

The editing menu in the header switches between **Collaborative** and **Local only**.

- **Collaborative** edits the shared draft. It saves as you type.
- **Local only** keeps your edits in this tab. They never save, and nobody else sees them. A reload keeps them. Closing the tab asks first.
- **Apply to shared draft** saves them over the shared draft they started from. Edits made during the save stay local. If someone saved the shared draft since, nothing is saved, and a comparison opens with **Overwrite with mine**, **Discard mine**, and **Keep editing locally**. With one editor at a time, Apply borrows the edit lease for the save, even in read-only mode. It never takes the lease over: while someone else edits, the banner says who, and **Retry** applies when they stop.
- **Discard** drops them. Switching to Collaborative or leaving with local edits asks you to apply or discard first.
- If someone deletes the shared draft, your local edits stay, even after a reload. The banner says so and offers **Copy**, **Discard**, and **Apply to shared draft**. Apply then opens a comparison, where **Create again from mine** saves your edits as a new draft. Publish is off until you apply or discard.
- **Publish shared draft** publishes the shared draft, never local edits. It shows what would go live, and refuses if the shared draft changed during review. If the site also changed, the comparison shows both. **Keep the shared draft** and **Use the site version** save only that one, and refuse if either changed again. Local edits stay until you apply them.

## The body round-trips

The rich editor edits the Markdown body through Comark. Opening a document or switching between Rich and Source writes nothing, so the text stays byte for byte until someone edits it. After an edit, the editor writes canonical Markdown, so `*` bullets can become `-`. Marks around the same text are equal to the editor, so `**[a](/x)**` can become `[**a**](/x)`.

If a body uses Markdown the rich editor would drop, such as a footnote definition the base parser drops, Rich mode is read-only for it and says so. Edit it in Source. Components round-trip through the shared Comark UI schema without a collection declaration.

Images from the `/` menu, or pasted or dropped into the body, go through the [media picker](#pick-media-for-documents). The title is the page heading, so start the body with its first paragraph, not a `# Title` that repeats it.

## Media library

**Media** shows the files of the Blob Store that [`blob.serve`](/docs/blob/configure) serves, or the `default` store if none is served. It appears when Blob is on. Every change goes through [`blob.media`](/docs/blob/media), so the library and your server code see the same records.

| Task | How |
| --- | --- |
| Browse | Folders and breadcrumbs, files in a grid or list. Thumbnails are small [variants](/docs/blob/media#image-variants) over the image's placeholder color. The URL holds the folder and open file, such as `?folder=posts&file=posts/cover.jpg`. |
| Find | Search by file name in the open folder and its subfolders. Filter by type: images, videos, audio, documents, or other. |
| Upload | Drop files on the library, or choose **Upload**. Files upload three at a time with progress. A failed file stays queued with its reason and **Retry**. Names become URL-safe (`Launch Day.PNG` is `launch-day.png`), and an existing name gets `-2`. Identical bytes reuse the stored file. |
| Organize | **New folder**, and **Rename or move…** on a file or folder. Select files with their checkbox, <kbd>⌘</kbd>-click, or <kbd>Shift</kbd>-click for a range, then **Move…** or **Delete**. <kbd>Esc</kbd> clears the selection. |
| Describe | Open a file for details. Alt text and caption save as you type. It shows dimensions, size, format, upload date, pathname, and a URL to copy. |
| Set the focal point | Click or drag on the image, or focus the marker and use the arrow keys. Previews at 1:1, 4:5, 16:9, and 1.91:1 crop around it like the serve route. |
| Art-direct | **Crops** lists named crops, such as `mobile` at 4:5. **Add crop** takes a name and an aspect. A crop cuts the original around the focal point until you **Upload replacement**, an image made for that size, such as a portrait version for phones. **Use the focal point** removes the replacement. Sites ask for a crop with `?crop=mobile` or [`responsiveImage({ art })`](/docs/blob/media#art-direction). |
| See where a file is used | **Used in** lists and links the drafts and published documents whose fields or body use the file. Moving or deleting a used file first warns with this list. |

Moves and deletes do not rewrite documents. A document keeps the old pathname until someone picks the file again.

## Pick media for documents

The editor picks media from the library:

- **Image…** in the <kbd>/</kbd> menu opens the library in a dialog. Pick or upload images, then **Insert**. With one image selected, the dialog shows its alt text. Editing it saves it to the file.
- Images pasted or dropped into the body upload at once to the folder you last opened in the library.
- A Blob reference field, such as `image()` or the [SEO](/docs/content/seo#seo-fields) social image, opens the same dialog and stores `{ pathname, contentType, size }`.

The body stores the Blob pathname, such as `![A field at sunrise](posts/cover.jpg)`, not a URL, so documents keep working when the serve route or host changes. The editor shows it through the served URL. When your site renders the Markdown, turn a `src` without a scheme or leading `/` into the served URL, such as `/api/_vitehub/blob/posts/cover.jpg`, or [`responsiveImage()`](/docs/blob/media#responsive-images) output.

### Who may change media

Media is part of the Content section, so a user needs the `content` section in `console.authorize`, not the Blob section. Blob still applies [`blob.serve.authorize`](/docs/blob/configure) to every thumbnail and preview, and stores every change.

All collections share media, so access follows [`authorize` in `defineContent()`](/docs/content/configure#access):

| Content access | Media |
| --- | --- |
| Read any collection | Browse and pick. |
| Write any collection | Also upload, create folders, and change alt text, captions, focal points, and crops. |
| Publish any collection | Also move, rename, and delete files and folders. These change published pages at once, without a publish. |

In the playground, writers upload and describe files, and editors also move and delete them. A request without access returns `403` with `MEDIA_FORBIDDEN`.

Agents cannot use the library, because it is part of the Console UI. To let an editor's agent on the [ViteHub MCP](/docs/development/mcp) list and upload media, also grant the library's Blob store, such as `'blob:media'` when `blob.serve.store` is `media`. The agent then runs `blob.list`, `blob.put`, and `blob.media` on that store only. Other stores, such as a private Content store, return `403`. See [Grant one Blob store](/docs/development/console#grant-one-blob-store).

## Publishing publishes what you reviewed

Every publish sends the documents and draft digests the editor showed, through [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed). **Publish** on a document saves pending edits, then sends the on-screen draft. **Publish N changes** and **Publish N selected** send the drafts the list loaded.

If someone saved one of those drafts after it loaded, Content publishes nothing and returns `WORKSPACE_CONFLICT` with the changed documents. The list names them. Choose **Refresh**, review the latest drafts, and publish again. The document editor loads the newer draft for you.

If a draft does not validate, for example after a field changed in `server/content.ts`, publishing returns `CONTENT_INVALID` and publishes nothing. The list names the document, and the editor highlights its fields. Fix them, save, and publish again.

## Give editors only the Content section

Two policies decide what an editor can do:

1. [`console.authorize`](/docs/development/console#limit-a-user-to-some-sections) decides which Console sections a request may use. Return `{ sections: ['content'] }` for editors.
2. [`authorize` in `defineContent()`](/docs/content/configure#access) decides what a user may do with each collection. The Console calls `content.can()` with the signed-in user before each read, save, delete, restore, and publish.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    auth: true,
    database: true,
    workspace: true,
    console: { authorize: './server/console-authorize.ts' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      auth: true,
      database: true,
      workspace: true,
      console: { authorize: './server/console-authorize.ts' },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      auth: true,
      database: true,
      workspace: true,
      console: { authorize: './server/console-authorize.ts' },
    }),
  ],
})
```
:::
::

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner') return true
  return { sections: ['content'] }
})
```

```ts [server/content.ts] fragment
export default defineContent({
  workspace: 'site',
  collections: { posts },
  // Writers save drafts. Only editors publish.
  authorize: ({ user, action }) => {
    if (user?.email === 'editor@example.com') return true
    if (user) return action !== 'publish'
    return false
  },
})
```

A writer sees the posts and saves drafts, with no publish buttons. A writer's publish request returns `403` with `CONTENT_FORBIDDEN`. For people who are not team owners, other Console sections return `403`, and the navigation shows only Content.

The Console passes the user that it signed:

| Caller | `user` in `content.can()` |
| --- | --- |
| The Console | The person signed in to the Console, with `id`, `name`, and `email`. |
| The CLI | `null`. Use `console.authorize` with `via: 'cli'` to decide which keys reach the section. |
| `console: { auth: false }` in development | The local developer, `{ id: 'local', name: 'You' }`. |

Saves, restores, deletes, and publishes record the user's `name`, `email`, or `id` as the revision author, shown in History.

## Playground

`playground/content` in the ViteHub repository is a full app with app Auth, the Blob + Database Store, two collections, and users with CMS roles: an admin, a publisher, an editor who cannot publish, and a reviewer. Its README shows how to run it.

## Limits

- The section loads `server/content.ts` on the first Content request, not at server start.
- Document requests accept bodies up to 1 MiB.
- The list reads all of a collection's documents into memory, like [`list()`](/docs/content/server-api). The dashboard and search read each collection's state once per request the same way.
- Recent activity shows the last 20 revisions, from at most 1,000 scanned per ref.
- The dashboard and search publish one collection at a time. If a draft moved after the page loaded, that collection publishes nothing and the Console asks you to refresh.
- History shows a document's last 20 saves and last 20 publishes, then older saves on request. Content scans at most 1,000 revisions per page.
- Uploads take files up to 32 MB per request. The file travels as base64 in the `media.upload` operation, so the request is a third larger than the file. The hosted Console sends files up to 9 MiB. Hosts can set a lower limit, such as 4.5 MB on Vercel Functions.
- Media search scans at most 5,000 files below the open folder and shows at most 60 matches. Open a folder to narrow it.
- **Used in** reads every document, on draft and published, of each collection the user may read. It finds bodies through the collection's [search fields](/docs/content/configure#define-collections), which include the body by default. It lists only documents the user may read, so the move or delete warning leaves out other documents that use the file. It does not tell which Blob Store a reference names.
- Media edits are last-writer-wins, like [`blob.media`](/docs/blob/media#consistency).
- Autosave starts only after a document exists. Leaving the page right after typing saves first. Closing the tab asks.
- Content supplies the Comark UI implementation and its editor dependencies.

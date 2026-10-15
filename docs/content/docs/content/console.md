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
- **Scheduled** lists every [scheduled publish](/docs/content/scheduling), soonest first, when there is one.
- **Recent activity** names who saved, deleted, restored, or published which document, and when.
- **Collections** lists each collection with a **New** button when you may edit it.

The sidebar lists the dashboard, every collection with its draft and changed counts, **Settings** and **Media** under **Manage**. Settings appears when you define a [singleton](/docs/content/configure#singletons-and-data-files); Media appears when the project enables Blob. Settings lists each singleton with its state, and opens it in the editor; singletons do not appear among the collections. Lists and the dashboard name a singleton by its `label`, such as **Settings**, not by its file name. **Media** opens the [media library](#media-library). Each page has a URL, such as `/_vitehub/content/-/media`. See [Section pages and URLs](/docs/development/console#section-pages-and-urls).

When the app lacks something a feature needs, the Console names the fix where the feature would be:

- Without [`authorize`](/docs/content/configure#access) in `defineContent()`, no one can read documents. The sidebar and the dashboard ask you to add it.
- Without a Schedule Definition that calls [`content.publishDue()`](/docs/content/scheduling#run-due-schedules), **Schedule…** is off, and an **Overdue** schedule names the fix.
- When the Console data needs a signed-in user, such as with `console: { auth: 'app' }`, the Console asks you to sign in.

<kbd>⌘</kbd> <kbd>K</kbd> searches the drafts of every collection by title, id, fields, and body. <kbd>Enter</kbd> opens a document, and <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. The same search creates documents and reviews and publishes all changes. See [Search](/docs/development/console#search).

## What editors can do

| Task | How |
| --- | --- |
| Find a document | Search, filter by state (draft, changed, published, deleted), filter by enum, boolean, and tag fields, and sort by title or the first date field. **Updated** shows when each document last changed; hover it for the exact time. |
| Edit fields | Property rows under the title, built from the collection's [JSON Schema](/docs/content/configure#fields). Empty optional fields fold behind **Show N more**. JSON and YAML documents have no body, so their property rows are the page and show every field. |
| Edit the body | A block editor over the Markdown. Select text for formatting, type <kbd>/</kbd> to insert blocks, images, and the collection's [components](/docs/content/configure#define-collections), and hover a block for ⋮⋮ (move, turn into, duplicate, copy link, delete) and + (insert below). |
| Edit SEO | A collection with a [`seo()` field](/docs/content/seo#seo-fields) gets an **SEO** group under the fields: title and description with character counters, the social image, the canonical URL, and **Hide from search**, with the fallbacks as placeholders and search result and social card previews. The group folds while the field is empty. |
| Edit settings | Open **Settings** in the sidebar, or search for the singleton with <kbd>⌘</kbd> <kbd>K</kbd>. A [singleton](/docs/content/configure#singletons-and-data-files), such as `settings`, opens straight into its editor, without a list. Before its first save it shows the field defaults, and the first edit saves it. It cannot be deleted from the Console. |
| See the file | **Source** (<kbd>⌘</kbd> <kbd>/</kbd>) shows the stored file: the frontmatter read-only and the Markdown body editable. |
| Save | Drafts save one second after typing stops. <kbd>⌘</kbd> <kbd>S</kbd> saves at once. A new document saves when you choose **Create**, since its id names the file. |
| Publish | **Publish** on a document, **Publish N changes** on a collection, **Publish** on the dashboard for every collection, or select documents and publish only those. |
| Schedule | The arrow next to **Publish** opens **Schedule…**: pick a date and time in your time zone, and the draft on screen publishes then. The header shows **Scheduled · Oct 20, 09:00**, the list gets a **Scheduled** tab, and the dashboard lists upcoming publishes under **Scheduled**. Saving the document again before then makes the schedule fail instead of publishing changes nobody reviewed. See [Scheduling](/docs/content/scheduling#console). |
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
| A Blob reference (`x-vitehub-blob`), such as `image()` or `file()` | A thumbnail and the file name with **Replace** and **Remove**. Choosing opens the [media picker](#pick-media-for-documents). An image also shows its alt text, which edits the alt text stored with the file. Without Blob in the project, the stored pathname shows read-only. |
| Anything else | A JSON text area. |

A field without a Standard JSON Schema, such as a Valibot validator, has the schema `{}` and gets the JSON text area. Optional fields left empty are removed before the save, so an empty input never saves `""` over a missing value.

## Saves never overwrite newer work

Each save sends the digest of the version the editor opened. When someone else saved the document in the meantime, Content returns `WORKSPACE_CONFLICT`. Saving pauses, the header reads **Not saved · newer version**, and a toast offers **Compare**. The comparison shows both versions: choose **Overwrite with mine** to save over the version you just compared, or **Load theirs**. **Keep editing** closes it and keeps your changes in the editor, still unsaved.

When a field does not validate, the draft still saves, so nothing you type is lost. The editor shows each message next to its field, and the header links to the first one. **Publish** stays off with "Fix 2 fields to publish" until the fields validate. The list and the dashboard mark such drafts with their issue count, and **Publish all** leaves them out.

## Editing together

The Console shows who else has a document open and gives one tab at a time the [edit lease](/docs/content/editing-together). It needs `contentSessionsSchema` in the Database of the Workspace history. With Realtime enabled, Markdown documents open in a [live session](/docs/content/editing-together#live-editing) instead: everyone edits at once, with carets and field focus, and the lease below applies only where live editing is unavailable.

- **Avatars.** The editor header shows up to three people, then `+N`. Hover one for `Ana · Editing` or `Ana · Viewing`. List rows show one small avatar, such as `Ana is editing`, and the dashboard lists documents under **Open now**.
- **First edit.** Opening a document does not lock it. The first keystroke claims the lease, and the edit stays on screen while the claim answers. Saving starts once this tab holds it.
- **Someone else is editing.** The dialog says `Ana is editing this page`, with **Open read-only** and **Take over**. <kbd>Esc</kbd> opens it read-only. People without write access never see **Take over**.
- **Read-only.** A line above the title says `Read-only · Ana is editing`, with **Take over**. When Ana leaves, it says `Ana stopped editing`, with **Reload and edit**.
- **Taken over.** The former editor sees `Ben took over · Your changes up to 10:42 are saved`, with **Compare** and **Take back**. Edits that could not save show as `1 edit wasn't saved`, with **Copy**.
- **Another tab of yours.** A second tab says `You're editing this in another tab` and offers the same choices.
- **Updates.** A page without unsaved edits reloads when someone else saves it. A page with unsaved edits keeps them, and the next save shows the comparison.
- **Unreachable.** When the Console cannot check sessions, the header says `Can't check who else is editing` and the page stays editable. Saves still refuse to overwrite a newer version.

The editor reports every 15 seconds while the tab is visible and every 60 seconds while it is hidden. After 15 minutes without input the tab views again and frees the lease; the next keystroke claims it again if it is free. Closing the tab releases the lease at once.

## The body round-trips

The body is Markdown, and the rich editor edits it through Comark. Opening a document and switching between Rich and Source writes nothing: the stored text stays byte for byte until someone edits it. After an edit the editor writes canonical Markdown, so formatting choices such as `*` bullets may become `-`.

When a body uses Markdown that the rich editor would drop, such as a component that the collection does not declare, Rich mode is read-only for that document and says so. Edit it in Source, or declare the component in `documents({ components })`.

Images inserted from the `/` menu, or pasted and dropped into the body, go through the [media picker](#pick-media-for-documents). The title is the page's heading, so start the body with its first paragraph rather than a `# Title` that repeats it.

## Media library

**Media** at `/_vitehub/content/-/media` shows the files of the Blob Store that [`blob.serve`](/docs/blob/configure) serves, or the `default` store when nothing is served. It appears when the project enables Blob. Every change goes through [`blob.media`](/docs/blob/media), so the library and your server code see the same records.

| Task | How |
| --- | --- |
| Browse | Folders and breadcrumbs, files in a grid or a list. Thumbnails are small [variants](/docs/blob/media#image-variants) over the image's placeholder color. The folder and the open file are in the URL, such as `?folder=posts&file=posts/cover.jpg`. |
| Find | Search by file name in the open folder and every folder below it, and filter by type: images, videos, audio, documents, or other. |
| Upload | Drop files anywhere on the library, or choose **Upload**. Files upload three at a time with progress; a failed file stays in the queue with its reason and **Retry**. Names become URL-safe: `Launch Day.PNG` is stored as `launch-day.png`, and a name that exists gets `-2`. When the store already holds the same bytes, the library points at that file instead of storing a copy. |
| Organize | **New folder**, and **Rename or move…** on a file or a folder. Select files with their checkbox, <kbd>⌘</kbd>-click, or <kbd>Shift</kbd>-click for a range, then **Move…** or **Delete**. <kbd>Esc</kbd> clears the selection. |
| Describe | Open a file for its details: alt text and caption save as you type, with dimensions, size, format, upload date, pathname, and URL to copy. |
| Set the focal point | Click or drag on the image, or focus the marker and use the arrow keys. Previews at 1:1, 4:5, 16:9, and 1.91:1 crop around it the way the serve route does. |
| Art-direct | **Crops** lists named crops, such as `mobile` at 4:5. **Add crop** takes a name and an aspect. A crop cuts the original around the focal point until you **Upload replacement**: an image made for that size, such as a portrait version for phones. **Use the focal point** removes the replacement. Sites ask for a crop with `?crop=mobile` or [`responsiveImage({ art })`](/docs/blob/media#art-direction). |
| See where a file is used | **Used in** lists the drafts and published documents whose fields or body use the file, and links to each. Moving or deleting a used file warns with the same list first. |

Moves and deletes do not rewrite documents. A document that used a moved or deleted file keeps the old pathname until someone picks the file again.

## Pick media for documents

The editor picks media from the library:

- **Image…** in the <kbd>/</kbd> menu opens the library in a dialog. Pick one or more images, or upload them there, then **Insert**. With one image selected, the dialog shows its alt text; editing it saves it to the file.
- Images pasted or dropped into the body upload right away to the folder you last opened in the library, without a dialog.
- A Blob reference field, such as `image()` or the [SEO](/docs/content/seo#seo-fields) social image, opens the same dialog and stores `{ pathname, contentType, size }`.

The body stores the Blob pathname, such as `![A field at sunrise](posts/cover.jpg)`, not a URL, so documents keep working when the serve route or host changes. The editor shows it through the served URL. When your site renders the Markdown, turn a `src` without a scheme or leading `/` into the served URL, such as `/api/_vitehub/blob/posts/cover.jpg`, or into [`responsiveImage()`](/docs/blob/media#responsive-images) output.

### Who may change media

Media belongs to the Content section, so a user needs the `content` section in `console.authorize`, not the Blob section. Blob itself still applies [`blob.serve.authorize`](/docs/blob/configure) to every thumbnail and preview, and stores every change.

What a user may do follows [`authorize` in `defineContent()`](/docs/content/configure#access), because media is shared by every collection:

| Content access | Media |
| --- | --- |
| Read any collection | Browse and pick. |
| Write any collection | Also upload, create folders, and change alt text, captions, focal points, and crops. |
| Publish any collection | Also move, rename, and delete files and folders. These change what published pages show at once, without a publish. |

In the playground, writers upload and describe files; editors also move and delete them. A request without the needed access returns `403` with `MEDIA_FORBIDDEN`.

## Publishing publishes what you reviewed

Every publish names the documents and the draft digests that the editor showed, through [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed). **Publish** on a document saves any pending edits first, then sends the draft on screen. **Publish N changes** and **Publish N selected** send the drafts the list loaded.

When someone saved one of those drafts after it loaded, Content publishes nothing and returns `WORKSPACE_CONFLICT` with the documents that changed. The list names them: choose **Refresh** to load the latest drafts, review them, and publish again. The document editor loads the newer draft for you.

When a draft does not validate, for example after a field changed in `server/content.ts`, publishing returns `CONTENT_INVALID` for that document and publishes nothing. The list names the document, and the editor highlights its fields. Fix them, save, and publish again.

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
- Uploads accept files up to 32 MB per request. Hosts may set a lower request limit, such as 4.5 MB on Vercel Functions.
- Media search scans at most 5,000 files below the open folder and shows at most 60 matches. Open a folder to narrow it.
- **Used in** reads every document of each collection the user may read, on the draft and published refs, and finds bodies through the collection's [search fields](/docs/content/configure#define-collections), which include the body by default. It does not tell which Blob Store a reference names.
- Media edits are last-writer-wins, like [`blob.media`](/docs/blob/media#consistency).
- A live preview of the page is not available yet.
- Drafts save on their own only after a document exists. Leaving the page right after typing saves first; closing the tab asks.
- The Nuxt module registers the page, but this editor has been verified only in the Vite Console. Nuxt hosts need `comark` and `comark-tiptap` installed.

---
title: Comments
seo.title: Comments UI components for Vue
description: "Figma-style comments for your own running app: pins, threads, a composer, a side list, and a side panel."
navigation.order: 34
navigation.group: Collaboration
icon: i-lucide-message-circle
---

`CommentLayer` adds Figma-style comments to a page. Press `C`, click a spot, write, and press `Enter`. A numbered pin with your avatar stays there, and the team replies in its thread.

The parts show state and call a transport. They do not store data or check access. The transport talks to the server:

- `createMemoryTransport()` from `@vite-hub/comments/testing` is for tests and examples.
- `createRestTransport()` from `@vite-hub/comments/client` connects to the [Comments API](/docs/comments/server-api#rest-transport) of the app.
- `createRpcTransport()` from `@vite-hub/comments/rpc` connects to the [Comments operations](/docs/comments/operations/server-api#browser-transport) on a development server only.

The built-in live-site overlay uses a different thread and anchor format.

::example{name="CommentComposerExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows, then add the client:

```bash
pnpm add @vite-hub/comments drizzle-orm@1.0.0-rc.5
```

`vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { CommentLayer } from "@vite-hub/ui";
```

## Usage

```ts
import { createCommentsClient } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";

const user = { id: "ana", name: "Ana Ruiz" };
const client = createCommentsClient({ transport: createMemoryTransport({ user }), user });
```

```vue
<template>
  <CommentLayer :client="client" :subject="{ kind: 'page', id: '/pricing' }" />
</template>
```

The layer loads the threads of the subject, draws a pin for each, and shows a toolbar with the comment and list buttons.

## How it works

- `C` or the toolbar button starts comment mode. The cursor becomes a speech bubble.
- A click drops a numbered pin with your avatar and opens its composer with focus.
- `Enter` sends. `Shift+Enter` breaks the line.
- `Esc` in an empty composer closes it.
- `Esc` or a click outside a composer with text shakes it, and keeps the focus and text. With reduced motion, the border flashes instead.
- `Esc` outside a composer leaves comment mode.
- Hover a pin to preview its thread. Click it to open the thread, reply, resolve, or reopen.
- Resolved threads have no pin until the Resolved filter is on.
- `?comment=<n>` in the URL opens thread `n` when the page loads.
- Type `@` to mention a person. The client's `users` call finds people. Names that start with your text come first, then names with a later word that starts with it. Accents and case do not count, so `@jose` finds José. People who already wrote in the thread come first. You are never in the list.
- In the mention menu, arrow keys move, `Enter` or `Tab` picks, and `Esc` closes only the menu. `Shift+Enter` still breaks the line.
- When `@` and two or more letters find no one, the menu shows one line instead of a list: "No one by that name can be mentioned here.", or "Could not load people." when the lookup fails. The composer logs the error with `console.warn`. The line is not an option, so `Enter` and `Tab` do not pick it. After a space, the menu stays closed, because the text is then more likely a sentence.
- A posted message shows each mention as a chip. A mention of you has another color.
- Paste, drop, or pick files when the app gives an `upload` function. See [Attachments](#attachments).
- Select text, then press `C`: the comment is about that text.
- A pin drops when the pointer goes up without moving. A touch that scrolls drops nothing.
- In comment mode, `Enter` starts a comment on the focused element. The toolbar button "Comment on page" comments on the whole page.
- A draft pin has no number. The server gives it one on send.
- A drag in comment mode draws an area, with its corners and size while the drag lasts. The comment is about that area.
- With `placement="margin"`, every thread is a card in a column on the right edge of the screen, level with its pin. Click a card or its pin to open the thread in that card and reply there. A new comment is written there too. On a screen narrower than 900px, threads open beside their pins.

An anchor stays on its element when the layout changes. When the element is gone, ambiguous, or no longer holds the quoted text, the thread is detached: it stays in the list without a pin. A pin also hides while a scroll container clips its element. See [Anchors](#anchors).

## Composition

```text
CommentLayer
├── CommentPin (one per thread, and one for the draft)
│   └── hover: CommentThread (preview)
│   └── open: CommentThread
│       ├── CommentReply (one per message)
│       └── CommentComposer (variant="reply")
├── CommentComposer (the new comment)
├── CommentToolbar
└── CommentList
    └── CommentFilters

CommentPanel
├── the list of threads, with Open and Resolved
├── CommentThread (navigation="back")
└── CommentComposer (a comment on the whole page)
```

Every part has a `data-slot`, as in shadcn/ui: `comment-layer`, `comment-pin`, `comment-thread`, `comment-reply`, `comment-composer`, `comment-mention`, `comment-list`, `comment-filters`, `comment-toolbar`, and `comment-panel`. The default styles sit in the `components` layer of `@vite-hub/ui/styles.css`, so utility classes override them.

## Build your own layout

`CommentLayer` renders the toolbar and the list. To place the parts yourself, use the default slot. It receives the `comments` state:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <template #default="{ comments }">
      <CommentToolbar :comments="comments" :people="people" />
      <CommentList :comments="comments" />
    </template>
  </CommentLayer>
</template>
```

Without the layer, call `useComments()` from `@vite-hub/ui/headless`. It needs no Nuxt UI. Pass the state it returns as the `comments` prop:

```ts fragment
import { useComments } from "@vite-hub/ui/headless";

const comments = useComments({ client, subject: { kind: "page", id: "/pricing" } });
comments.pageThreads.value; // The threads of this page, after the filters.
comments.toggle(); // Comment mode.
comments.startDraft({ x: 120, y: 80 }); // Start a comment on a point.
comments.startDraft(element, { area, files: [screenshot] }); // Start one on an area, with a file in its box.
await comments.create({ body: "Looks good" }); // A comment on the whole page.
comments.people.value; // The people that the state knows, for mention names.
```

| Option | Description |
| --- | --- |
| `client` | The `CommentsClient`. Required. |
| `subject` | What the threads are about. A value, ref, or getter. Required. |
| `user` | The signed-in user. Defaults to `client.user`. |
| `root` | Where to look up anchors. Defaults to the document. |
| `param` | The query parameter of the deep link. Default `"comment"`. |
| `hotkey` | The key of comment mode. Default `"c"`. `false` turns it off. |
| `ignore` | Elements anchors skip. Defaults to the comment UI. |
| `uiRoot` | The document or shadow root that holds the comment UI, where composers with text are found. Defaults to the document. |
| `subjectUrl` | The page URL of a subject, for thread links. Page subjects use their id as the path. Other subjects link to the current page unless you give it. |
| `autoStart` | Load threads and listen for keys on mount. Default `true`. When `false`, call `start()` yourself. |
| `can` | What the user may do in a thread. See [Permissions](#permissions). |

## Side panel

`CommentPanel` shows all comments of a page in one surface, like the side panel of a review tool. It lists threads with Open and Resolved filters. Click a thread to open it in the panel. Back returns to the list with focus on that thread. The box at the bottom comments on the whole page.

::example{name="CommentPanelExample" height=8}
::

Inside `CommentLayer`, the panel uses the layer's state. Put it in the layer's slot to replace the toolbar and list:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <aside class="fixed inset-y-0 right-0 w-80">
      <CommentPanel />
    </aside>
  </CommentLayer>
</template>
```

Without a layer, give it a `client` and `subject`, or a `comments` state.

- `variant="docked"` fills its container, such as a side column.
- `variant="floating"` is a card with a border and shadow. Place it with a class.
- `v-model:thread` opens a thread from your code. `v-model:status` keeps the filter.

The panel keeps its own open thread. A click outside does not close it, because the panel stays on screen.

Each row shows the number, author, start of the first message as plain text, and facts such as the reply count. The `preview` slot replaces the text, and the `row` slot replaces the whole row. Both get `{ thread, text }`, where `text` is the default row text. Render `text` for rows you don't change. To group threads under headings, give `group` a function that returns a thread's heading, or `undefined` for none. Threads without a heading come first, then each group in order of first appearance. The `group-header` slot gets `{ group, threads }`:

```vue
<template>
  <CommentPanel :group="(thread) => (thread.createdAt < publishedAt ? 'From earlier versions' : undefined)">
    <template #preview="{ thread, text }">
      <SuggestionPreview v-if="thread.metadata?.suggestion" :thread="thread" />
      <template v-else>{{ text }}</template>
    </template>
  </CommentPanel>
</template>
```

## Permissions

A thread shows Resolve, Reopen, Edit, Delete, and the reply box only to users who may use them. By default, a signed-in user may reply to and resolve any thread, and edit and delete their own messages. A reader without a user gets no controls. Give `useComments()` a `can` function with your own rules, and every part follows them:

```ts fragment
const comments = useComments({
  client,
  subject,
  // `action` is "reply", "resolve", "edit", or "delete". `message` is set for "edit" and "delete".
  can: (action, { thread, message }) => {
    if (action === "resolve") return isManager.value || thread.author.id === me.value.id;
    if (action === "delete") return isManager.value || message?.author.id === me.value.id;
    return action === "reply" || message?.author.id === me.value.id;
  },
});
```

`CommentLayer`, `CommentPanel`, and `CommentThread` also take a `can` prop, which wins over the state. `readOnly` hides every control.

> [!WARNING]
> These rules only hide controls. The server must still check each request.

## Mentions

A composer finds people from, in order:

1. The `users` prop.
2. The comments state of the nearest `CommentLayer`, `CommentPanel`, or `provideComments()`. It calls the client's `users`.
3. The `people` prop.

So inside a layer or panel, mentions work with no props. Pass `participants`, the ids of people in the conversation, to show them first. A thread passes its authors' ids.

A posted message shows `@Name` as a `comment-mention` chip for each id in `message.mentions`. The name comes from the part's `people` prop, or from people the comments state knows: the user, thread authors, and people that `users` found. The signed-in user's chip has `data-self="true"`. Code spans and code blocks keep `@` as text.

## Attachments

A composer takes files from paste, drop, and the file button. It sends them as `File` objects in `submit`: `{ body, mentions, files }`. It does not upload them.

- `attachments: false` turns the file button off. An edit never has files.
- `accept` limits the file types, such as `image/*`.
- A new comment needs text unless you set `allowEmpty`. A reply can send files without text.
- `v-model:files` lets the parent clear the files after a send.

`CommentThread` passes the files to `onReply` as the third argument. `CommentLayer` and `CommentPanel` take files only with `upload`: a function that stores the files and returns their keys, such as Blob keys. They send the keys as the message `attachments`.

Transports accept attachment keys by default, including `createRestTransport()` and `createRpcTransport()`. A transport that cannot can set `supportsAttachments: false`. The layer and panel then disable file controls, even with `upload`.

```vue
<script setup lang="ts">
async function upload(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  return await $fetch<string[]>("/api/uploads", { method: "POST", body: form });
}
</script>

<template>
  <CommentPanel :upload="upload" :attachment-url="(key) => `/api/uploads/${key}`" accept="image/*" />
</template>
```

`attachmentUrl` turns a key into a URL. With it, an image shows as a thumbnail that opens full size, and other files show as link chips. Without it, the message shows file names. An attachment counts as an image when its name has an image extension, such as `.png`, or no extension. When the key does not tell, return the media type with the URL:

```ts
// The files that `upload` stored, by key
const uploads = new Map<string, File>();

const attachmentUrl = (key: string) => ({ url: `/api/files/${key}`, name: uploads.get(key)?.name, type: uploads.get(key)?.type });
```

## Slots

| Part | Slot | Scope | Where it renders |
| --- | --- | --- | --- |
| `CommentThread` | `actions` | `{ thread }` | In the header, before Resolve. |
| `CommentThread` | `anchor` | `{ thread }` | Instead of the selected-text quote. |
| `CommentThread` | `after` | `{ thread }` | Below the messages, above the reply box. |
| `CommentReply` | `body` | `{ message }` | Instead of the Markdown body. |
| `CommentReply` | `attachments` | `{ message }` | Instead of the default attachments. |
| `CommentComposer` | `extra` | | Above the text field, such as a suggested-change field. |
| `CommentComposer` | `mention-item` | `{ person, active }` | Each person of the mention menu. |
| `CommentComposer` | `mention-empty` | `{ query, failed }` | The line of the mention menu when it has no one to show. |
| `CommentPanel`, `CommentList` | `row`, `preview` | `{ thread, text }` | One list row, or its text. `text` is the default row text. |
| `CommentPanel` | `group-header` | `{ group, threads }` | A row group heading. See `group`. |

`CommentThread` passes `body`, `attachments`, `extra`, `mention-item`, and `mention-empty` to its messages and reply box. `CommentPanel` passes every slot to its thread, and `extra`, `mention-item`, and `mention-empty` to its page box.

::example{name="CommentThreadSlotsExample" height=8}
::

## Themes

The parts use Nuxt UI tokens, such as `--ui-bg`, `--ui-text`, `--ui-border`, and `--ui-primary`. Each element reads them where it renders, so a class on the surface or any element around it themes only that surface. You do not need to set the `--vh-ui-*` tokens too. For a dark panel on a light page, add Nuxt UI's `dark` class:

```vue
<template>
  <aside class="dark">
    <CommentPanel />
  </aside>
</template>
```

Or set the tokens on your own class:

```css
.review-surface {
  --ui-bg: #18181b;
  --ui-bg-elevated: #27272a;
  --ui-text: #e4e4e7;
  --ui-text-highlighted: #fff;
  --ui-border: #3f3f46;
}
```

`--vh-comment-mention-bg` and `--vh-comment-mention-self-bg` set mention chip colors.

`--vh-ui-comment-mark` sets the color of a drawn area. It defaults to the focus blue (`--vh-focus`), else Nuxt UI's `--ui-info`, so an area shows on a dark page and on a white image in it.

## Anchors

An anchor says where a comment sits. `createAnchor()` makes one from an element, a point, a selection, or `"page"`. `resolveAnchor()` finds it again.

The selector uses the first of `data-comment-id`, `id`, and `data-testid` that matches exactly one element. Else it is a short path from the nearest stable ancestor. Offsets are in thousandths of the element box, so pins follow their element on resize. Add `data-comment-id` to an element that must keep its comments when the markup changes.

Read more in the [`@vite-hub/comments` README](https://github.com/vite-hub/vitehub/tree/main/packages/comments).

## Accessibility

- A pin is a button. Its label has the number, author, and start of the comment, such as "Comment 3 by Ana Ruiz: Make this bigger", and says when the thread is resolved. `aria-expanded` shows if its thread is open.
- An open thread is a `dialog` named "Comment 3". Opening it moves focus into it. Closing it returns focus to its pin, unless the reader moved focus elsewhere.
- The composer has a label. Its box is a `combobox`. While the mention menu is open, the box has `aria-expanded="true"`, `aria-controls`, and `aria-activedescendant`. The menu is a `listbox`. A menu with no one to show is a `status` with one line and no options, so the box keeps `aria-expanded="false"`.
- In `CommentPanel`, threads are buttons in a list. Back moves focus to the thread that was open. The Open and Resolved filters have `aria-pressed`.
- Deleting the first message asks first, because it deletes the thread.
- The toolbar is a `toolbar`. The comment button has `aria-pressed` and `aria-keyshortcuts="C"`.
- Under `prefers-reduced-motion` the composer does not shake. Its border flashes.

## API Reference

### CommentLayer

The page overlay. Renders a `div` with `data-slot="comment-layer"`. Give it a `client` and `subject`, or a `comments` state.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `CommentsClient` | | The client. Needed without `comments`. |
| `subject` | `CommentSubject` | | What the threads are about. Needed without `comments`. |
| `user` | `CommentUser` | | The signed-in user. Defaults to the client's user. |
| `comments` | `CommentsState` | | A state from `useComments()`, instead of `client` and `subject`. |
| `people` | `AvatarStackPerson[]` | `[]` | People on the page, shown in the toolbar's [Avatar Stack](/docs/ui/avatar-stack). |
| `hotkey` | `string \| false` | `"c"` | The key of comment mode. |
| `readOnly` | `boolean` | `false` | Hide reply, edit, delete, and status controls. |
| `subjectUrl` | `(subject: CommentSubject) => string \| undefined` | | The page URL of a subject, for links of non-page threads. |
| `can` | `(action, { thread, message }) => boolean` | | What the user may do in a thread. Defaults to the state's `can`. See [Permissions](#permissions). |
| `navigate` | `(href: string) => void` | | Opens the page of a listed thread. Defaults to `location.assign`. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores files and returns their keys. Without it, boxes take no files. |
| `accept` | `string` | | File types the boxes take, such as `image/*`. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `placement` | `"pin" \| "margin"` | `"pin"` | Where threads open: beside their pins, or in cards on the right edge of the screen, level with their pins. `"margin"` works as `"pin"` below 900px. |

### CommentPin

Renders a `button` with `data-slot="comment-pin"`, with the author's avatar and the thread number.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `n` | `number` | | The thread number. A draft has none. |
| `author` | `CommentUser` | | Whose avatar shows. |
| `excerpt` | `string` | | The start of the comment, used in the label. |
| `status` | `"open" \| "resolved"` | `"open"` | A resolved pin is gray. |
| `active` | `boolean` | `false` | The thread of this pin is open. |
| `draft` | `boolean` | `false` | The comment is not sent yet. |

#### Events

| Event | Description |
| --- | --- |
| `select` | The pin was clicked. |
| `hover` | The pointer or the focus came to the pin. |
| `leave` | The pointer or the focus left the pin. |

### CommentThread

The thread of one pin, as a card. With `preview`, it is the read-only hover card. Renders a `section` with `data-slot="comment-thread"`.

Handlers may return a promise, and the thread waits for it. The reply box clears only after `onReply` succeeds. On failure, the text stays and the error shows. While a reply is sending, the box cannot send again.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `thread` | `CommentThread` | Required | The thread. |
| `user` | `CommentUser` | | The signed-in user, who can edit and delete their messages. |
| `preview` | `boolean` | `false` | A read-only card with the comment and the reply count. |
| `readOnly` | `boolean` | `false` | Show the full thread without reply, edit, delete, or status controls. |
| `can` | `(action, { thread, message }) => boolean` | | What the signed-in user may do: `reply`, `resolve`, `edit`, or `delete`. Defaults to the state's `can`, else [the default rules](#permissions). |
| `busy` | `boolean` | `false` | Show a reply as sending, on top of the thread's own tracking. |
| `error` | `string` | | An error to show, on top of handler errors. |
| `detached` | `boolean` | `false` | The thread's spot is no longer on the page. |
| `people` | `CommentUser[]` | `[]` | People messages may mention, besides thread authors. Their mentions show as chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state. |
| `attachments` | `boolean` | `true` | The reply box takes files. |
| `accept` | `string` | | File types the reply box takes. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `navigation` | `"close" \| "back"` | `"close"` | `"back"` shows Back at the start of the header instead of Close. Both emit `close`. |
| `dismissible` | `boolean` | `true` | A click outside the thread closes it. Turn it off in a panel. |
| `onReply` | `(body: string, mentions: string[], files: File[]) => void \| Promise<unknown>` | | Sends a reply. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves an edited message. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes a message. Deleting the first message deletes the thread, after a confirmation. |
| `onResolve` | `() => void \| Promise<unknown>` | | Resolve was pressed. |
| `onReopen` | `() => void \| Promise<unknown>` | | Reopen was pressed. |

#### Events

| Event | Description |
| --- | --- |
| `close` | Close or Back was pressed, or the reader clicked outside. |

The component ref exposes `close()`. Call it when a parent dialog or panel wants to close the thread. Like the header button, it checks for unsent replies and edits before it emits `close`.

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `actions` | `{ thread }` | More header buttons, before Resolve. |
| `anchor` | `{ thread }` | What the thread is about. Replaces the selected-text quote. |
| `after` | `{ thread }` | Below the messages, above the reply box. |
| `body`, `attachments` | `{ message }` | Passed on to each `CommentReply`. |
| `extra`, `mention-item`, `mention-empty` | | Passed on to the reply box. |

### CommentReply

One message of a thread. The first message is the comment, the rest are replies. Its author can edit and delete it. Renders a `div` with `data-slot="comment-reply"`. The body is [Markdown](/docs/ui/markdown), with a `comment-mention` chip for each person in `message.mentions`. The edit box closes after `onEdit` succeeds. On failure, it stays open with the text and error.

Edit and Delete show when you give their handlers. An unchanged edit keeps its mention ids, even when a name is unknown. For changed text, pass mentioned people in `people` so the composer can check which names remain.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | `CommentMessage` | Required | The message. |
| `user` | `CommentUser` | | The signed-in user, whose mention chip has `data-self="true"`. Defaults to the state's user. |
| `editable` | `boolean` | `false` | Show Edit when `onEdit` is given. |
| `deletable` | `boolean` | | Show Delete when `onDelete` is given. Defaults to `editable`. |
| `compact` | `boolean` | `false` | Clamp the body to three lines, without actions. |
| `confirmDelete` | `boolean` | `false` | Confirm before Delete. Threads set it on the first message. |
| `people` | `CommentUser[]` | `[]` | People the message may mention, so edits keep their mentions and the body shows chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions` while editing. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves the edit. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes the message. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `body` | `{ message }` | Replaces the Markdown body. |
| `attachments` | `{ message }` | Replaces the default attachment list. |
| `mention-item` | `{ person, active }` | Passed on to the edit box. |
| `mention-empty` | `{ query, failed }` | Passed on to the edit box. |

### CommentComposer

The box for a new comment, a reply, or an edit. It wraps [Prompt Input](/docs/ui/prompt-input). With `layout="row"` it is one row under a divider: attach, the text, and send. The reply box of a thread and the box at the bottom of a panel use it. Renders a `div` with `data-slot="comment-composer"` and `data-layout`. It has `data-shake` while it shakes, `data-dirty` while it has text or files, and `data-dragging` while files are dragged over it.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `modelValue` | `string` | `""` | The text. Use `v-model`. |
| `mentions` | `string[]` | `[]` | The ids of the people mentioned. Use `v-model:mentions`. |
| `files` | `File[]` | | The attached files. Use `v-model:files` to clear them after a send. Without it, the box keeps its own list. |
| `user` | `CommentUser` | | Who writes. They are not in the mention menu. |
| `variant` | `"comment" \| "reply" \| "edit"` | `"comment"` | Sets the label and placeholder. |
| `placeholder` | `string` | | Defaults to the variant placeholder. |
| `busy` | `boolean` | `false` | A send is running. The box keeps its text and cannot send again. |
| `error` | `string` | | Why the last send failed. |
| `autofocus` | `boolean` | `true` | Focus the box when it appears. |
| `guard` | `boolean` | `true` | A click outside closes an empty box and shakes a box with text. Turn it off when the parent decides. |
| `people` | `CommentUser[]` | `[]` | People the text may mention. A mention is sent only while its `@name` is in the text, so deleting the name drops it. |
| `participants` | `string[]` | `[]` | Ids of people in the conversation, shown first in the mention menu. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state, else `people`. See [Mentions](#mentions). |
| `attachments` | `boolean` | `true` | Take files from paste, drop, and the file button. Edits never take files. |
| `accept` | `string` | | File types to take, like a file input's `accept`. |
| `allowEmpty` | `boolean` | | Send files without text. Defaults to on for a reply and off for a new comment. |
| `layout` | `"box" \| "row"` | `"box"` | `box` is a bordered field. `row` is one line that shows its edge only while it has the focus, for a box inside a card. |

#### Events

| Event | Description |
| --- | --- |
| `update:modelValue` | Text changed. Gets the text. |
| `update:mentions` | Mentions changed. Gets their ids. |
| `update:files` | Files changed. Gets the files. |
| `submit` | `Enter` was pressed with text, or with files when allowed. Gets `{ body, mentions, files }`. |
| `cancel` | `Esc` in an empty box, or a click outside it. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `extra` | | Above the text field, such as a suggested-change field. |
| `mention-item` | `{ person, active }` | One person of the mention menu. `active` is true for the person the arrow keys are on. |
| `mention-empty` | `{ query, failed }` | The line of the mention menu when it has no one to show. `query` is the text after `@`. `failed` is true when the lookup failed. |

The component exposes `focus()` and `shake()`.

### CommentPanel

The thread list, one thread, and a page box in one surface. Renders a `section` with `data-slot="comment-panel"`, `data-variant`, and `data-view` (`list` or `thread`). Give it a `client` and `subject`, a `comments` state, or put it inside `CommentLayer`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | A state from `useComments()`. Defaults to the state of the nearest `CommentLayer` or `provideComments()`. |
| `client` | `CommentsClient` | | The client, for a panel without a layer. Use with `subject`. |
| `subject` | `CommentSubject` | | What the threads are about, with `client`. |
| `user` | `CommentUser` | | The signed-in user, with `client`. Defaults to the client's user. |
| `variant` | `"docked" \| "floating"` | `"docked"` | `docked` fills its container. `floating` is a card with border and shadow. |
| `thread` | `string \| null` | | The open thread id. Use `v-model:thread`. Without it, the panel keeps its own. |
| `status` | `"open" \| "resolved"` | | Which threads the list shows. Use `v-model:status`. Defaults to `"open"`. |
| `title` | `string` | `"Comments"` | The heading of the list. |
| `readOnly` | `boolean` | `false` | Hide the page box and all reply, edit, delete, and status controls. |
| `can` | `(action, { thread, message }) => boolean` | | What the user may do in a thread. Defaults to the state's `can`. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores files and returns their keys. Without it, boxes take no files. |
| `accept` | `string` | | File types the boxes take. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `allowEmpty` | `boolean` | `false` | Allow a new page comment with files and no text. |
| `people` | `CommentUser[]` | `[]` | People messages may mention, besides the people the state knows. |
| `group` | `(thread: CommentThread) => string \| undefined` | | The group heading of a row. Rows without a group come first. |

#### Events

| Event | Description |
| --- | --- |
| `update:thread` | A thread opened, or Back was pressed. Gets the id or `null`. |
| `update:status` | Open or Resolved was pressed. Gets the status. |
| `select` | A listed thread was clicked. Gets the thread. |

#### Slots

Every slot of [CommentThread](#commentthread). `extra`, `mention-item`, and `mention-empty` also go to the page box.

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | Replaces the number, avatar, text, and facts of one row. |
| `preview` | `{ thread, text }` | The text of one row. Render `text` to keep the default. |
| `group-header` | `{ group, threads }` | A row group heading. Replaces the text `group` returned. |
| `list-actions` | | Buttons at the end of the list's top row, such as Close. |

### CommentToolbar

The comment, "Comment on page", and list buttons, and the people on the page. Its default slot adds your tools after them, such as an Edit link. Renders a `div` with `data-slot="comment-toolbar"`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. |

### CommentList

The side list of threads. Renders a `section` with `data-slot="comment-list"`. It lists threads of this page or every page, with the filters. Each row links to the thread's page with `?comment=<n>`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |
| `navigate` | `(href: string) => void` | | Opens the page of a thread on another page. Defaults to `location.assign`. |

#### Events

| Event | Description |
| --- | --- |
| `select` | A row was clicked. Gets the thread. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | Replaces the number, avatar, text, and facts of one row. |
| `preview` | `{ thread, text }` | The text of one row. Render `text` to keep the default. |

### CommentFilters

Open, Resolved, and Mine toggles. Renders a `div` with `data-slot="comment-filters"`. The filters apply to the pins and the list.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows who is on the page.
- [Prompt Input](/docs/ui/prompt-input) is the composer's box.
- [Attachment](/docs/ui/attachment) shows the files of a message.
- [Markdown](/docs/ui/markdown) renders the messages.

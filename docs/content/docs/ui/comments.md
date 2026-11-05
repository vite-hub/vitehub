---
title: Comments
description: "Figma-style comments for your own running app: pins, threads, a composer, a side list, and a side panel."
navigation.order: 34
navigation.group: Collaboration
icon: i-ph-chat-circle-light
---

`CommentLayer` puts Figma-style comments on a page. Press `C`, click a spot, write, and press `Enter`. A numbered pin with your avatar stays there, and the team replies in its thread.

The parts show state and call a transport. They do not own storage or access. The transport is the seam to the server: `@vite-hub/comments/testing` has `createMemoryTransport()` for tests and examples, and `createRpcTransport()` from `@vite-hub/comments/rpc` connects to the [Comments Operations server](/docs/comments/operations/get-started). The built-in live-site overlay uses a separate thread and anchor format.

::component-preview{name="CommentComposerExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation), and add the client:

```bash
pnpm add @vite-hub/comments
```

The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/comments`:

```ts
import { CommentLayer } from "@vite-hub/ui/comments";
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

The layer loads the threads of the subject, draws a pin for each one, and shows a toolbar with the comment button and the list button.

## How it works

- `C` or the toolbar button turns on comment mode. The cursor becomes a speech bubble.
- A click drops a numbered pin with your avatar. Its composer opens with the focus in it.
- `Enter` sends. `Shift+Enter` breaks the line.
- `Esc` in an empty composer closes it.
- `Esc` in a composer that has text shakes it. The focus and the text stay. A click outside does the same. When the reader prefers reduced motion, the border flashes instead.
- `Esc` outside a composer leaves comment mode.
- Hover a pin to preview its thread. Click it to open the thread, reply, resolve it, or reopen it.
- Resolved threads have no pin until the Resolved filter is on.
- `?comment=<n>` in the URL opens thread `n` when the page loads.
- Type `@` in a composer to mention a person. The client's `users` call finds people. Names that start with what you typed come first, then names with a later word that starts with it. Accents and case do not count, so `@jose` finds José. People who already wrote in the thread come first, and you are never in the list.
- In the mention menu, the arrow keys move, `Enter` or `Tab` picks, and `Esc` closes only the menu and keeps the text. `Shift+Enter` still breaks the line.
- A posted message shows each person it mentions as a chip. A mention of you has another color.
- Paste, drop, or pick files in a composer when the app gives an `upload` function. See [Attachments](#attachments).
- Select text, then press `C`: the comment is about that text.
- A pin drops when the pointer goes up, and only if it stayed in place. A touch that scrolls the page drops nothing.
- Keyboard: in comment mode, `Enter` on the focused element starts a comment on it. The toolbar button "Comment on page" starts a comment on the whole page.
- A draft pin has no number. The server assigns it when the comment is sent.

An anchor stays on its element when the layout changes. When the element is gone, ambiguous, or no longer holds the quoted text, the thread is detached: it stays in the list and has no pin. A pin is also hidden while a scroll container clips its element. [Anchors](#anchors) explains how a pin finds its spot.

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

Every part has a `data-slot`, as in shadcn/ui: `comment-layer`, `comment-pin`, `comment-thread`, `comment-reply`, `comment-composer`, `comment-mention`, `comment-list`, `comment-filters`, `comment-toolbar`, and `comment-panel`. The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so utility classes override them.

## Build your own layout

`CommentLayer` renders the toolbar and the list. To place the parts yourself, give the layer a slot. The slot receives the `comments` state:

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

To go without the layer, call `useComments()` from `@vite-hub/ui/headless`. It needs no Nuxt UI. It returns the state that the parts use, and you pass it as the `comments` prop:

```ts
import { useComments } from "@vite-hub/ui/headless";

const comments = useComments({ client, subject: { kind: "page", id: "/pricing" } });
comments.pageThreads.value; // The threads of this page, after the filters.
comments.toggle(); // Comment mode.
comments.startDraft({ x: 120, y: 80 }); // Start a comment on a point.
await comments.create({ body: "Looks good" }); // A comment on the whole page.
comments.people.value; // The people that the state knows, for mention names.
```

| Option | Description |
| --- | --- |
| `client` | The `CommentsClient`. Required. |
| `subject` | What the threads of this page are about. A value, a ref, or a getter. Required. |
| `user` | The signed-in user. Defaults to `client.user`. |
| `root` | Where anchors are looked up. Defaults to the document. |
| `param` | The query parameter of the deep link. Default `"comment"`. |
| `hotkey` | The key of comment mode. Default `"c"`. `false` turns it off. |
| `ignore` | Elements that anchors skip. Defaults to the comment UI. |
| `uiRoot` | The document or the shadow root that holds the comment UI. Composers with text are looked up there. Defaults to the document. |
| `subjectUrl` | The URL of the page that a subject lives on, for the link of a thread. Page subjects use their id as the path. Give it for other subjects, or their link is the current page. |
| `autoStart` | Load the threads and listen for keys on mount. Default `true`. Call `start()` yourself when `false`. |
| `can` | What the signed-in user may do in a thread. See [Permissions](#permissions). |

## Side panel

`CommentPanel` is one surface for the comments of a page, as in the side panel of a review tool. It shows the list of threads with Open and Resolved filters. A click on a thread opens it in the panel, and Back returns to the list with the focus on that thread. The box at the bottom comments on the whole page.

::component-preview{name="CommentPanelExample"}
::

Inside `CommentLayer` the panel uses the layer's state. Put it in the layer's slot to replace the toolbar and the list:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <aside class="fixed inset-y-0 right-0 w-80">
      <CommentPanel />
    </aside>
  </CommentLayer>
</template>
```

Without a layer, give it a `client` and a `subject`, or a `comments` state. `variant="docked"` fills its container, such as a side column. `variant="floating"` is a card with a border and a shadow; place it with a class. Use `v-model:thread` to open a thread from your own code, and `v-model:status` to keep the filter.

The panel keeps its own open thread. A click outside does not close it, because the panel stays on the screen.

Each row shows the number, the author, the start of the first message as plain text, and facts such as the reply count. The `preview` slot replaces the text, and the `row` slot replaces the whole row. Both get `{ thread, text }`, where `text` is the text that the row shows by default. Render `text` for the rows that you don't change, so they keep the default. To put some threads under a heading, give `group` a function that returns the heading of a thread, or `undefined` for none. Threads without a heading come first, then each group in the order it first appears. The `group-header` slot gets `{ group, threads }`:

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

A thread shows Resolve, Reopen, Edit, Delete, and the reply box only to a user who may use them. By default a signed-in user may reply to and resolve any thread, and edit and delete their own messages; a reader without a user gets none of the controls. Give `useComments()` a `can` function with your own rules, and every part of the state follows them:

```ts
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

`CommentLayer`, `CommentPanel`, and `CommentThread` also take `can` as a prop, which wins over the state. `readOnly` hides every control. The controls are only what the reader sees: the server still checks each request.

## Mentions

A composer finds people in this order:

1. The `users` prop.
2. The comments state of the nearest `CommentLayer`, `CommentPanel`, or `provideComments()`. It calls the client's `users`.
3. The `people` prop.

So inside a layer or a panel the mention menu works with no props. Pass `participants`, the ids of the people in the conversation, to show them first. A thread passes the ids of its authors.

A posted message marks `@Name` for each id in `message.mentions` with a `comment-mention` chip. The name comes from the `people` prop of the part, or from the people that the comments state knows: the user, the authors of the threads, and the people that `users` found. The chip of the signed-in user has `data-self="true"`. Code spans and code blocks keep their `@` as text, and the rest of the Markdown renders as before.

## Attachments

A composer takes files from the clipboard, from a drop on the box, and from the file button. It sends them as `File` objects in `submit`: `{ body, mentions, files }`. It does not upload them.

- `attachments: false` turns the file button off. An edit never has files.
- `accept` limits the file types, such as `image/*`.
- A new comment needs text. Set `allowEmpty` to send files without text. A reply can send files without text.
- `v-model:files` holds the files, so the parent can clear them after a send.

`CommentThread` passes the files to `onReply` as the third argument. `CommentLayer` and `CommentPanel` take files only when you give them `upload`: a function that stores the files and returns their keys, such as Blob keys. They send the keys as the `attachments` of the message.

Transports accept attachment keys by default, including `createRpcTransport()`. A transport that cannot accept attachment keys can set `supportsAttachments: false`; the layer and panel then keep file controls disabled even with `upload`.

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

`attachmentUrl` turns a key into a URL. With it, an image attachment shows as a thumbnail that opens the full image, and another file shows as a chip with a link. Without it, the message shows the file names. An attachment is an image when its name has an image extension, such as `.png`, or no extension. When the key does not say, return the media type with the URL:

```ts
const attachmentUrl = (key: string) => ({ url: `/api/files/${key}`, name: files[key]?.name, type: files[key]?.type });
```

## Slots

The slots receive the data that they show:

| Part | Slot | Scope | Where it renders |
| --- | --- | --- | --- |
| `CommentThread` | `actions` | `{ thread }` | In the header, before Resolve. |
| `CommentThread` | `anchor` | `{ thread }` | Instead of the quote of the selected text. |
| `CommentThread` | `after` | `{ thread }` | Below the messages, above the reply box. |
| `CommentReply` | `body` | `{ message }` | Instead of the Markdown body. |
| `CommentReply` | `attachments` | `{ message }` | Instead of the default attachments. |
| `CommentComposer` | `extra` | | Above the text field, for example a field for a suggested change. |
| `CommentComposer` | `mention-item` | `{ person, active }` | Each person of the mention menu. |
| `CommentPanel`, `CommentList` | `row`, `preview` | `{ thread, text }` | One row of the list, or its text. `text` is the default text of the row. |
| `CommentPanel` | `group-header` | `{ group, threads }` | The heading of a group of rows. See `group`. |

`CommentThread` passes `body`, `attachments`, `extra`, and `mention-item` on to its messages and its reply box. `CommentPanel` passes every slot on to its thread, and `extra` and `mention-item` to its page box.

::component-preview{name="CommentThreadSlotsExample"}
::

## Themes

The parts use the Nuxt UI tokens, such as `--ui-bg`, `--ui-text`, `--ui-border`, and `--ui-primary`. Each element of a part reads them where it renders, so a class on the surface, or on any element around it, themes only that surface. You do not set the `--vh-ui-*` tokens as well. To show a dark panel on a light page, add Nuxt UI's `dark` class:

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

`--vh-comment-mention-bg` and `--vh-comment-mention-self-bg` set the colors of mention chips.

## Anchors

An anchor says where a comment sits. `createAnchor()` makes one from an element, a point, a selection, or `"page"`. `resolveAnchor()` finds it again.

The selector uses the first of `data-comment-id`, `id`, and `data-testid` that names exactly one element. Else it is a short path from the nearest stable ancestor. Offsets are in thousandths of the element box, so a pin follows its element when the window resizes. Add `data-comment-id` to an element that must keep its comments when the markup changes.

Read more in the [`@vite-hub/comments` README](https://github.com/vite-hub/vitehub/tree/main/packages/comments).

## Accessibility

- A pin is a button. Its label has the number, the author, and the start of the comment, for example "Comment 3 by Ana Ruiz: Make this bigger", and it says when the thread is resolved. `aria-expanded` shows whether its thread is open.
- An open thread is a `dialog` that is named "Comment 3". Opening it moves the focus into it. Closing it gives the focus back to its pin, unless the reader already moved the focus elsewhere.
- The composer has a label. Its box is a `combobox`. While the mention menu is open, the box has `aria-expanded="true"`, `aria-controls`, and `aria-activedescendant`, and the menu is a `listbox`.
- In `CommentPanel` the threads are buttons in a list. Back gives the focus to the thread that was open. The Open and Resolved filters have `aria-pressed`.
- Deleting the first message of a thread asks first, because it deletes the thread.
- The toolbar is a `toolbar`. The comment button has `aria-pressed` and `aria-keyshortcuts="C"`.
- Under `prefers-reduced-motion` the composer does not shake. Its border flashes.

## API Reference

### CommentLayer

The overlay of a page. Renders a `div` with `data-slot="comment-layer"`. Give it a `client` and a `subject`, or a `comments` state.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `CommentsClient` | | The client. Needed when `comments` is not set. |
| `subject` | `CommentSubject` | | What the threads are about. Needed when `comments` is not set. |
| `user` | `CommentUser` | | The signed-in user. Defaults to the client's user. |
| `comments` | `CommentsState` | | A state from `useComments()`, instead of `client` and `subject`. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. The toolbar shows them in an [Avatar Stack](/docs/ui/avatar-stack). |
| `hotkey` | `string \| false` | `"c"` | The key of comment mode. |
| `readOnly` | `boolean` | `false` | Hide reply, edit, delete, and status controls in threads. |
| `subjectUrl` | `(subject: CommentSubject) => string \| undefined` | | The URL of the page of a subject, for the links of threads that are not page threads. |
| `can` | `(action, { thread, message }) => boolean` | | What the signed-in user may do in a thread. Defaults to the `can` of the state. See [Permissions](#permissions). |
| `navigate` | `(href: string) => void` | | Goes to the page of a thread that the list shows. Defaults to `location.assign`. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores attached files and returns their keys. Without it the boxes take no files. |
| `accept` | `string` | | The file types that the boxes take, such as `image/*`. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of an attachment key, or the URL with its file name and media type. Images show as thumbnails that open full size, other files as links. |

### CommentPin

The pin. Renders a `button` with `data-slot="comment-pin"`. The pin has the author's avatar and the thread number.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `n` | `number` | | The thread number. A draft has none. |
| `author` | `CommentUser` | | Whose avatar shows. |
| `excerpt` | `string` | | The start of the comment. It is part of the label. |
| `status` | `"open" \| "resolved"` | `"open"` | A resolved pin is gray. |
| `active` | `boolean` | `false` | The thread of this pin is open. |
| `draft` | `boolean` | `false` | The comment is still being written. |

#### Events

| Event | Description |
| --- | --- |
| `select` | The pin was clicked. |
| `hover` | The pointer or the focus came to the pin. |
| `leave` | The pointer or the focus left the pin. |

### CommentThread

The thread of one pin, as a card. With `preview` it is the read-only hover card. Renders a `section` with `data-slot="comment-thread"`.

The handlers may return a promise. The thread waits for it. A reply clears its box only after `onReply` has succeeded. On a failure the text stays and the error shows. While a reply is on its way, the box cannot send again.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `thread` | `CommentThread` | Required | The thread. |
| `user` | `CommentUser` | | The signed-in user. Their messages can be edited and deleted. |
| `preview` | `boolean` | `false` | A read-only card with the comment and the reply count. |
| `readOnly` | `boolean` | `false` | Keep the full thread readable without reply, edit, delete, or status controls. |
| `can` | `(action, { thread, message }) => boolean` | | What the signed-in user may do: `reply`, `resolve`, `edit`, or `delete`. Defaults to the `can` of the comments state, else to [the default rules](#permissions). |
| `busy` | `boolean` | `false` | Show a reply as being sent, on top of the thread's own tracking. |
| `error` | `string` | | An error to show, on top of the ones from the handlers. |
| `detached` | `boolean` | `false` | The place of the thread is no longer on the page. |
| `people` | `CommentUser[]` | `[]` | People that messages may mention, on top of the authors of the thread. Their mentions show as chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state. |
| `attachments` | `boolean` | `true` | The reply box takes files. |
| `accept` | `string` | | The file types that the reply box takes. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of an attachment key, or the URL with its file name and media type. Images show as thumbnails that open full size, other files as links. |
| `navigation` | `"close" \| "back"` | `"close"` | `"back"` puts a Back button at the start of the header instead of Close. Both emit `close`. |
| `dismissible` | `boolean` | `true` | A click outside the thread closes it. Turn it off in a panel. |
| `onReply` | `(body: string, mentions: string[], files: File[]) => void \| Promise<unknown>` | | Sends a reply. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves an edited message. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes a message. Deleting the first message deletes the thread, and the thread asks first. |
| `onResolve` | `() => void \| Promise<unknown>` | | Resolve was pressed. |
| `onReopen` | `() => void \| Promise<unknown>` | | Reopen was pressed. |

#### Events

| Event | Description |
| --- | --- |
| `close` | Close or Back was pressed, or the reader clicked outside. |

The component ref exposes `close()`. Call it when a containing dialog or panel requests dismissal so it checks for unsent replies and edits before emitting `close`, just as the header button does.

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `actions` | `{ thread }` | More buttons in the header, before Resolve. |
| `anchor` | `{ thread }` | What the thread is about. Replaces the quote of the selected text. |
| `after` | `{ thread }` | Below the messages, above the reply box. |
| `body`, `attachments` | `{ message }` | Passed on to each `CommentReply`. |
| `extra`, `mention-item` | | Passed on to the reply box. |

### CommentReply

One message of a thread. The first message is the comment, and the rest are replies. Its author can edit it in place and delete it. Renders a `div` with `data-slot="comment-reply"`. The body is [Markdown](/docs/ui/markdown), with a `comment-mention` chip for each person in `message.mentions`. The edit box closes after `onEdit` has succeeded. On a failure it stays open with the text and the error.

Edit and Delete are shown when their respective handlers are supplied. An unchanged edit keeps existing mention IDs even when the mentioned person's name is unavailable. For changed text, supply mentioned people through `people` so the composer can check which names remain.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | `CommentMessage` | Required | The message. |
| `user` | `CommentUser` | | The signed-in user. Their mention chip has `data-self="true"`. Defaults to the user of the comments state. |
| `editable` | `boolean` | `false` | Show Edit when `onEdit` is given. |
| `deletable` | `boolean` | | Show Delete when `onDelete` is given. Defaults to `editable`. |
| `compact` | `boolean` | `false` | Clamp the body to three lines, without actions. |
| `confirmDelete` | `boolean` | `false` | Ask before Delete. A thread sets it on the first message. |
| `people` | `CommentUser[]` | `[]` | People whose `@name` the message may hold, so an edit keeps their mentions and the body shows them as chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions` while editing. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of an attachment key, or the URL with its file name and media type. Images show as thumbnails that open full size, other files as links. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves the edit. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes the message. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `body` | `{ message }` | The text of the message. Replaces the Markdown body. |
| `attachments` | `{ message }` | The attachments of the message. Replaces the default list. |
| `mention-item` | `{ person, active }` | Passed on to the edit box. |

### CommentComposer

The box for a new comment, a reply, or an edit. It wraps [Prompt Input](/docs/ui/prompt-input). At the bottom of a panel or a thread it is one row under a divider: attach, the text, and send. Renders a `div` with `data-slot="comment-composer"`. It has `data-shake` while it shakes, `data-dirty` while it has text or files, and `data-dragging` while files are dragged over it.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `modelValue` | `string` | `""` | The text. Use `v-model`. |
| `mentions` | `string[]` | `[]` | The ids of the people mentioned. Use `v-model:mentions`. |
| `files` | `File[]` | | The attached files. Use `v-model:files` to clear them after a send. Without it the box keeps its own list. |
| `user` | `CommentUser` | | Who writes. They are not in the mention menu. |
| `variant` | `"comment" \| "reply" \| "edit"` | `"comment"` | Sets the label and the placeholder. |
| `placeholder` | `string` | | The placeholder. Defaults to the variant placeholder. |
| `busy` | `boolean` | `false` | A send is running. The box keeps its text and cannot send again. |
| `error` | `string` | | Why the last send failed. |
| `autofocus` | `boolean` | `true` | Focus the box when it appears. |
| `guard` | `boolean` | `true` | A click outside closes an empty box, and shakes a box with text. Turn it off when the parent decides. |
| `people` | `CommentUser[]` | `[]` | People whose `@name` the text may hold. A mention is sent only when its `@name` is still in the text, so deleting the name drops the mention. |
| `participants` | `string[]` | `[]` | The ids of the people in the conversation. The mention menu shows them first. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state, else to `people`. See [Mentions](#mentions). |
| `attachments` | `boolean` | `true` | Take files from paste, drop, and the file button. An edit never takes files. |
| `accept` | `string` | | The file types to take, as the `accept` of a file input. |
| `allowEmpty` | `boolean` | | Send files without text. Defaults to on for a reply and off for a new comment. |

#### Events

| Event | Description |
| --- | --- |
| `update:modelValue` | The text changed. Gets the text. |
| `update:mentions` | The mentioned people changed. Gets their ids. |
| `update:files` | The attached files changed. Gets the files. |
| `submit` | `Enter` was pressed with text, or with files when that is allowed. Gets `{ body, mentions, files }`. |
| `cancel` | `Esc` was pressed in an empty box, or the reader clicked outside it. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `extra` | | Above the text field, for example a field for a suggested change. |
| `mention-item` | `{ person, active }` | One person of the mention menu. `active` is true for the person that the arrow keys are on. |

The component exposes `focus()` and `shake()`.

### CommentPanel

The list of threads, one thread, and a page box in one surface. Renders a `section` with `data-slot="comment-panel"`, `data-variant`, and `data-view` (`list` or `thread`). Give it a `client` and a `subject`, a `comments` state, or put it inside `CommentLayer`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | A state from `useComments()`. Defaults to the state of the nearest `CommentLayer` or `provideComments()`. |
| `client` | `CommentsClient` | | The client, for a panel without a layer. Give it with `subject`. |
| `subject` | `CommentSubject` | | What the threads are about, with `client`. |
| `user` | `CommentUser` | | The signed-in user, with `client`. Defaults to the client's user. |
| `variant` | `"docked" \| "floating"` | `"docked"` | `docked` fills its container. `floating` is a card with a border and a shadow. |
| `thread` | `string \| null` | | The id of the open thread. Use `v-model:thread`. Without it the panel keeps its own. |
| `status` | `"open" \| "resolved"` | | Which threads the list shows. Use `v-model:status`. Defaults to `"open"`. |
| `title` | `string` | `"Comments"` | The heading of the list. |
| `readOnly` | `boolean` | `false` | Hide the page box and every reply, edit, delete, and status control. |
| `can` | `(action, { thread, message }) => boolean` | | What the signed-in user may do in a thread. Defaults to the `can` of the state. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores attached files and returns their keys. Without it the boxes take no files. |
| `accept` | `string` | | The file types that the boxes take. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of an attachment key, or the URL with its file name and media type. Images show as thumbnails that open full size, other files as links. |
| `allowEmpty` | `boolean` | `false` | Send a new page comment that has files and no text. |
| `people` | `CommentUser[]` | `[]` | People that messages may mention, on top of the people that the state knows. |
| `group` | `(thread: CommentThread) => string \| undefined` | | The heading of the group of a row. Rows without a group come first. |

#### Events

| Event | Description |
| --- | --- |
| `update:thread` | A thread opened, or Back was pressed. Gets the id or `null`. |
| `update:status` | Open or Resolved was pressed. Gets the status. |
| `select` | A thread of the list was clicked. Gets the thread. |

#### Slots

Every slot of [CommentThread](#commentthread). `extra` and `mention-item` also go to the page box.

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | The inside of one row. Replaces the number, avatar, text, and facts. |
| `preview` | `{ thread, text }` | The text of one row. Replaces the start of the first message. Render `text` to keep the default for a row. |
| `group-header` | `{ group, threads }` | The heading of a group of rows. Replaces the text that `group` returned. |
| `list-actions` | | Buttons at the end of the list's top row, beside Open and Resolved, such as Close. |

### CommentToolbar

The comment button, the "Comment on page" button, the list button, and the people on the page. Its default slot adds your own tools after them, such as an Edit link. Renders a `div` with `data-slot="comment-toolbar"`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Inherits the layer's state when omitted. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. |

### CommentList

The side list of threads. Renders a `section` with `data-slot="comment-list"`. It lists the threads of this page or of every page, and takes the filters. Each row is a link to the page of the thread with `?comment=<n>`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Inherits the layer's state when omitted. |
| `navigate` | `(href: string) => void` | | Goes to the page of a thread that is not on this page. Defaults to `location.assign`. |

#### Events

| Event | Description |
| --- | --- |
| `select` | A row was clicked. Gets the thread. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | The inside of one row. Replaces the number, avatar, text, and facts. |
| `preview` | `{ thread, text }` | The text of one row. Replaces the start of the first message. Render `text` to keep the default for a row. |

### CommentFilters

Open, Resolved, and Mine. Each is a toggle. Renders a `div` with `data-slot="comment-filters"`. The filters apply to the pins and to the list.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Inherits the layer's state when omitted. |

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows who is on the page.
- [Prompt Input](/docs/ui/prompt-input) is the box inside the composer.
- [Attachment](/docs/ui/attachment) shows the files of a message.
- [Markdown](/docs/ui/markdown) renders the messages.

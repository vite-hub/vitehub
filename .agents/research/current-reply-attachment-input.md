# Current Reply Attachment Input

## Decision

An attachment on the message explicitly selected by the current inbound reply is current Agent input automatically. Applications do not configure a reply-attachment mode. The rule lives at ViteHub's shared Chat SDK conversion boundary and therefore applies to every present or future adapter that supplies normalized `Message.replyTo.attachments`.

Automatic content is deliberately narrower than automatic URL fetching:

- `Attachment.data` and adapter-owned `Attachment.fetchData()` are content.
- A URL-only attachment is an unresolved reference.
- `Message.links`, provider thread ids, and URLs in text are not attachment content.
- Reply attachments reached through fetched history remain reference-only.

ViteHub keeps safe reference metadata next to the content part, but excludes provider download URLs and rehydration metadata from Agent input and durable Workflow records.

## Why the default changed

[PR #751](https://github.com/vite-hub/vitehub/pull/751) established the option-free attachment contract for current Channel messages. [PR #948](https://github.com/vite-hub/vitehub/pull/948) then classified replied media as history and retained only metadata to prevent stale callback reads, repeated transcription, and quoted command execution. That preserved safety but made a common Telegram turn—replying to a photo with an instruction—impossible because Telegram photos are callback-only.

The revised rule keeps #948's command and history boundaries. It promotes content only from the current inbound reply, uses a top-level attachment part with a collision-free id, and leaves reply text as structured context. [PR #951](https://github.com/vite-hub/vitehub/pull/951) proves the content must be top-level and materialized before durable Workflow serialization.

## Cross-channel evidence

At Chat SDK commit [`7609d8f`](https://github.com/vercel/chat/commit/7609d8f60e8bfe4832d6c2d3b8c19aaec1f3bdab), Telegram is the only inbound adapter that populates normalized `replyTo`. Teams, Slack, and Google Chat keep thread routing in thread identifiers; Discord flattens forwarded snapshots into the current message. ViteHub must not guess a reply from those provider-specific fields. An adapter that later supplies `replyTo.attachments` gets the ViteHub behavior without another change.

Chat SDK models links separately and renders their metadata as text without calling `fetchMessage`. Teams also distinguishes live Activity attachments from Graph references and hosted content. Its live adapter owns authenticated and guarded `fetchData()` resolution; Graph history can expose URL-only SharePoint references that ViteHub cannot resolve generically. See [Microsoft Teams file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4), [Graph attachment types](https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0), and [short-lived preauthenticated downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

The boundary also avoids turning a conversational feature into an SSRF or indirect prompt-import mechanism. Adapter-owned resolvers can enforce provider authentication and destination policy; arbitrary URLs cannot. See [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) and [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

## Reversing conditions

Revisit the no-option rule if Chat SDK intentionally redefines `replyTo` as every structural thread parent, or if applications demonstrate a privacy or cost requirement that cannot be expressed through the existing attachment limits. Telegram's implicit forum-topic parent is an adapter normalization edge case and should be filtered there; it is not a reason to add provider branches or an application switch in ViteHub.

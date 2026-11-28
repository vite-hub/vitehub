export type UIMigrationKind = "prop" | "event" | "slot" | "component" | "removed"

export interface UIMigration {
  component: string
  from: string
  to: string | null
  kind: UIMigrationKind
  note: string
}

export const uiMigrations: readonly UIMigration[] = [
  { component: "CopyButton", from: "icon", to: "icon", kind: "slot", note: "Put the icon component in the `#icon` slot." },
  { component: "CopyButton", from: "ariaLabel", to: "aria-label", kind: "prop", note: "Set `aria-label` as an attribute. It falls through to the button." },
  { component: "CopyButton", from: "variant", to: "variant", kind: "prop", note: "`variant=\"subtle\"` becomes `variant=\"soft\"`." },
  { component: "CopyButton", from: "size", to: "size", kind: "prop", note: "`size=\"xl\"` becomes `size=\"lg\"`." },
  { component: "PromptInput", from: "attachments", to: null, kind: "removed", note: "Leave out `PromptInputAttach` in the composition to turn off files." },
  { component: "PromptInput", from: "attachVariant", to: "variant", kind: "prop", note: "Set `variant` on `PromptInputAttach`." },
  { component: "PromptInput", from: "multiple", to: "single", kind: "prop", note: "`:multiple=\"false\"` becomes `single`." },
  { component: "PromptInput", from: "filesDisabled", to: null, kind: "removed", note: "Set `disabled` on `PromptInputAttach`." },
  { component: "PromptInput", from: "reload", to: "retry", kind: "event", note: "Listen to `@retry`." },

  { component: "DropField", from: "files", to: "select", kind: "event", note: "Listen to `@select`. The payload is `{ files }`." },
  { component: "HoldToDelete", from: "state", to: "update:status", kind: "event", note: "Bind `v-model:status` or listen to `@update:status`." },
  { component: "RelativeTime", from: "tooltip", to: "plain", kind: "prop", note: "`:tooltip=\"false\"` becomes `plain`." },
  { component: "DeviceFrame", from: "toolbar", to: "bare", kind: "prop", note: "`:toolbar=\"false\"` becomes `bare`." },
  { component: "AvatarStack", from: "size", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "AvatarStack", from: "variant", to: "variant", kind: "prop", note: "`variant=\"default\"` becomes `variant=\"solid\"`." },
  { component: "FilterSearch", from: "size", to: "size", kind: "prop", note: "`size=\"xl\"` becomes `size=\"lg\"`." },
  { component: "ChoicesInputClear", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "ChoicesInputField", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Marker", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Marker", from: "variant", to: "variant", kind: "prop", note: "`\"default\"` becomes `\"ghost\"`, `\"border\"` becomes `\"outline\"`, and `\"separator\"` becomes a `MarkerSeparator` part." },
  { component: "MorphText", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "RollNumber", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MotionList", from: "tag", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },

  { component: "CodeBlock", from: "size", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "CodeBlock", from: "variant", to: "tone", kind: "prop", note: "`variant=\"destructive\"` becomes `tone=\"error\"`. Remove `variant=\"default\"`." },
  { component: "CodeBlockLine", from: "variant", to: "kind", kind: "prop", note: "Use `kind` with the same value. Remove `variant=\"default\"`." },
  { component: "MarkdownEditor", from: "uploadError", to: "error", kind: "event", note: "Listen to `@error`. The payload is `{ error, file }`." },

  { component: "Bubble", from: "variant", to: "variant", kind: "prop", note: "`\"default\"` becomes `\"solid\"`, `\"secondary\"` and `\"muted\"` become `\"soft\"`, and `\"tinted\"` becomes `variant=\"soft\" tone=\"info\"`." },
  { component: "BubbleContent", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Attachment", from: "state", to: "status", kind: "prop", note: "Use `status` with the same value." },
  { component: "Attachment", from: "size", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "AttachmentMedia", from: "variant", to: "kind", kind: "prop", note: "Use `kind` with the same value." },
  { component: "AttachmentTrigger", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScroller", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScroller", from: "autoScroll", to: "manualScroll", kind: "prop", note: "`:auto-scroll=\"false\"` becomes `manual-scroll`." },
  { component: "MessageScrollerButton", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerContent", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerContent", from: "preserveScrollOnPrepend", to: "jumpOnPrepend", kind: "prop", note: "`:preserve-scroll-on-prepend=\"false\"` becomes `jump-on-prepend`." },
  { component: "MessageScrollerItem", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerViewport", from: "as", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },

  { component: "CommentComposer", from: "variant", to: "mode", kind: "prop", note: "Use `mode` with the same value." },
  { component: "CommentComposer", from: "attachments", to: null, kind: "removed", note: "Leave out the files part in the composition to turn off files." },
  { component: "CommentComposer", from: "autofocus", to: "manualFocus", kind: "prop", note: "`:autofocus=\"false\"` becomes `manual-focus`." },
  { component: "CommentComposer", from: "guard", to: "unguarded", kind: "prop", note: "`:guard=\"false\"` becomes `unguarded`." },
  { component: "CommentPanel", from: "variant", to: "placement", kind: "prop", note: "Use `placement` with the same value." },
  { component: "CommentThread", from: "attachments", to: null, kind: "removed", note: "Leave out the files part in the composition to turn off files." },
  { component: "CommentThread", from: "dismissible", to: "persistent", kind: "prop", note: "`:dismissible=\"false\"` becomes `persistent`." },
  { component: "CommentThread", from: "onReply", to: "reply", kind: "event", note: "Listen to `@reply`. The payload is `{ body, mentions, files }`." },
  { component: "CommentThread", from: "onResolve", to: "resolve", kind: "event", note: "Listen to `@resolve`." },
  { component: "CommentThread", from: "onReopen", to: "reopen", kind: "event", note: "Listen to `@reopen`." },
  { component: "CommentThread", from: "onEdit", to: "edit", kind: "event", note: "Listen to `@edit`. The payload is `{ messageId, body, mentions }`." },
  { component: "CommentThread", from: "onDelete", to: "delete", kind: "event", note: "Listen to `@delete`. The payload is `{ messageId }`." },
  { component: "CommentReply", from: "onEdit", to: "edit", kind: "event", note: "Listen to `@edit`. The payload is `{ messageId, body, mentions }`." },
  { component: "CommentReply", from: "onDelete", to: "delete", kind: "event", note: "Listen to `@delete`. The payload is `{ messageId }`." },
  { component: "CommentPin", from: "n", to: "number", kind: "prop", note: "Use `number` with the same value." },

  { component: "AgentSession", from: "defaultDetailsOpen", to: "defaultDetailsClosed", kind: "prop", note: "`:default-details-open=\"false\"` becomes `default-details-closed`." },
  { component: "AgentSessionDetailsRow", from: "icon", to: "icon", kind: "slot", note: "Put the icon component in the `#icon` slot." },
  { component: "AgentSessionDetailsRow", from: "tone", to: "tone", kind: "prop", note: "`tone=\"default\"` and `tone=\"muted\"` become `tone=\"neutral\"`." },
  { component: "Workspace", from: "share", to: "private", kind: "prop", note: "`:share=\"false\"` becomes `private`." },
  { component: "WorkspaceBootStatus", from: "online", to: "offline", kind: "prop", note: "`:online=\"false\"` becomes `offline`." },
  { component: "WorkspaceBootStatus", from: "retry-install", to: "retry", kind: "event", note: "Listen to `@retry`. The payload `{ step }` names the step." },
  { component: "WorkspaceBootStatus", from: "show-output", to: "show", kind: "event", note: "Listen to `@show`." },
  { component: "ConnectPanel", from: "empty", to: "emptyLabel", kind: "prop", note: "Use `empty-label` with the same text." },
  { component: "ConnectPanel", from: "oauth", to: "authorize", kind: "event", note: "Listen to `@authorize`." },
  { component: "ConnectPanel", from: "copy-command", to: "copy", kind: "event", note: "Listen to `@copy`." },
  { component: "ConnectPanel", from: "remove-all", to: "clear", kind: "event", note: "Listen to `@clear`." },
  { component: "ConnectProviderRow", from: "oauth", to: "authorize", kind: "event", note: "Listen to `@authorize`." },
  { component: "ConnectProviderRow", from: "copy-command", to: "copy", kind: "event", note: "Listen to `@copy`." },
  { component: "BrowserSupportNotice", from: "copied", to: "copy", kind: "event", note: "Listen to `@copy`. The payload is `{ url }`." },
]

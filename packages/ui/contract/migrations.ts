export type UISurfaceKind = "prop" | "event" | "slot" | "component" | "entry"
export type UIMigrationKind = UISurfaceKind | "removed"

export interface UIMigration {
  component: string
  from: string
  fromKind: UISurfaceKind
  to: string | null
  kind: UIMigrationKind
  note: string
}

export const uiMigrations: readonly UIMigration[] = [
  { component: "CopyButton", from: "icon", fromKind: "prop", to: "icon", kind: "slot", note: "Put the icon component in the `#icon` slot." },
  { component: "CopyButton", from: "ariaLabel", fromKind: "prop", to: "aria-label", kind: "prop", note: "Set `aria-label` as an attribute. It falls through to the button." },
  { component: "CopyButton", from: "variant", fromKind: "prop", to: "variant", kind: "prop", note: "`variant=\"subtle\"` becomes `variant=\"soft\"`." },
  { component: "CopyButton", from: "size", fromKind: "prop", to: "size", kind: "prop", note: "`size=\"xl\"` becomes `size=\"lg\"`." },
  { component: "PromptInput", from: "attachments", fromKind: "prop", to: null, kind: "removed", note: "Leave out `PromptInputAttach` in the composition to turn off files." },
  { component: "PromptInput", from: "attachVariant", fromKind: "prop", to: "variant", kind: "prop", note: "Set `variant` on `PromptInputAttach`." },
  { component: "PromptInput", from: "multiple", fromKind: "prop", to: "single", kind: "prop", note: "`:multiple=\"false\"` becomes `single`." },
  { component: "PromptInput", from: "filesDisabled", fromKind: "prop", to: null, kind: "removed", note: "Set `disabled` on `PromptInputAttach`." },
  { component: "PromptInput", from: "reload", fromKind: "event", to: "retry", kind: "event", note: "Listen to `@retry`." },

  { component: "DropField", from: "files", fromKind: "event", to: "select", kind: "event", note: "Listen to `@select`. The payload is `{ files }`." },
  { component: "HoldToDelete", from: "state", fromKind: "event", to: "update:status", kind: "event", note: "Bind `v-model:status` or listen to `@update:status`." },
  { component: "RelativeTime", from: "tooltip", fromKind: "prop", to: "plain", kind: "prop", note: "`:tooltip=\"false\"` becomes `plain`." },
  { component: "DeviceFrame", from: "toolbar", fromKind: "prop", to: "bare", kind: "prop", note: "`:toolbar=\"false\"` becomes `bare`." },
  { component: "AvatarStack", from: "size", fromKind: "prop", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "AvatarStack", from: "variant", fromKind: "prop", to: "variant", kind: "prop", note: "`variant=\"default\"` becomes `variant=\"solid\"`." },
  { component: "FilterSearch", from: "size", fromKind: "prop", to: "size", kind: "prop", note: "`size=\"xl\"` becomes `size=\"lg\"`." },
  { component: "ChoicesInputClear", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "ChoicesInputField", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Marker", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Marker", from: "variant", fromKind: "prop", to: "variant", kind: "prop", note: "`\"default\"` becomes `\"ghost\"`, `\"border\"` becomes `\"outline\"`, and `\"separator\"` becomes a `MarkerSeparator` part." },
  { component: "MorphText", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "RollNumber", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MotionList", from: "tag", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },

  { component: "CodeBlock", from: "size", fromKind: "prop", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "CodeBlock", from: "variant", fromKind: "prop", to: "tone", kind: "prop", note: "`variant=\"destructive\"` becomes `tone=\"error\"`. Remove `variant=\"default\"`." },
  { component: "CodeBlockLine", from: "variant", fromKind: "prop", to: "kind", kind: "prop", note: "Use `kind` with the same value. Remove `variant=\"default\"`." },
  { component: "MarkdownEditor", from: "uploadError", fromKind: "event", to: "error", kind: "event", note: "Listen to `@error`. The payload is `{ error, file }`." },

  { component: "Bubble", from: "variant", fromKind: "prop", to: "variant", kind: "prop", note: "`\"default\"` becomes `\"solid\"`, `\"secondary\"` and `\"muted\"` become `\"soft\"`, and `\"tinted\"` becomes `variant=\"soft\" tone=\"info\"`." },
  { component: "BubbleContent", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "Attachment", from: "state", fromKind: "prop", to: "status", kind: "prop", note: "Use `status` with the same value." },
  { component: "Attachment", from: "size", fromKind: "prop", to: "size", kind: "prop", note: "`size=\"default\"` becomes `size=\"md\"`." },
  { component: "AttachmentMedia", from: "variant", fromKind: "prop", to: "kind", kind: "prop", note: "Use `kind` with the same value." },
  { component: "AttachmentTrigger", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScroller", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScroller", from: "autoScroll", fromKind: "prop", to: "manualScroll", kind: "prop", note: "`:auto-scroll=\"false\"` becomes `manual-scroll`." },
  { component: "MessageScrollerButton", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerContent", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerContent", from: "preserveScrollOnPrepend", fromKind: "prop", to: "jumpOnPrepend", kind: "prop", note: "`:preserve-scroll-on-prepend=\"false\"` becomes `jump-on-prepend`." },
  { component: "MessageScrollerItem", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },
  { component: "MessageScrollerViewport", from: "as", fromKind: "prop", to: "render", kind: "slot", note: "Use the `#render` slot of ui-sdk." },

  { component: "CommentComposer", from: "variant", fromKind: "prop", to: "mode", kind: "prop", note: "Use `mode` with the same value." },
  { component: "CommentComposer", from: "attachments", fromKind: "prop", to: null, kind: "removed", note: "Leave out the files part in the composition to turn off files." },
  { component: "CommentComposer", from: "autofocus", fromKind: "prop", to: "manualFocus", kind: "prop", note: "`:autofocus=\"false\"` becomes `manual-focus`." },
  { component: "CommentComposer", from: "guard", fromKind: "prop", to: "unguarded", kind: "prop", note: "`:guard=\"false\"` becomes `unguarded`." },
  { component: "CommentPanel", from: "variant", fromKind: "prop", to: "placement", kind: "prop", note: "Use `placement` with the same value." },
  { component: "CommentThread", from: "attachments", fromKind: "prop", to: null, kind: "removed", note: "Leave out the files part in the composition to turn off files." },
  { component: "CommentThread", from: "dismissible", fromKind: "prop", to: "persistent", kind: "prop", note: "`:dismissible=\"false\"` becomes `persistent`." },
  { component: "CommentPin", from: "n", fromKind: "prop", to: "number", kind: "prop", note: "Use `number` with the same value." },

  { component: "AgentSession", from: "defaultDetailsOpen", fromKind: "prop", to: "defaultDetailsClosed", kind: "prop", note: "`:default-details-open=\"false\"` becomes `default-details-closed`." },
  { component: "AgentSessionDetailsRow", from: "icon", fromKind: "prop", to: "icon", kind: "slot", note: "Put the icon component in the `#icon` slot." },
  { component: "AgentSessionDetailsRow", from: "tone", fromKind: "prop", to: "tone", kind: "prop", note: "`tone=\"default\"` and `tone=\"muted\"` become `tone=\"neutral\"`." },
  { component: "Workspace", from: "share", fromKind: "prop", to: "private", kind: "prop", note: "`:share=\"false\"` becomes `private`." },
  { component: "WorkspaceBootStatus", from: "online", fromKind: "prop", to: "offline", kind: "prop", note: "`:online=\"false\"` becomes `offline`." },
  { component: "WorkspaceBootStatus", from: "retry-install", fromKind: "event", to: "retry", kind: "event", note: "Listen to `@retry`. The payload `{ step }` names the step." },
  { component: "WorkspaceBootStatus", from: "show-output", fromKind: "event", to: "show", kind: "event", note: "Listen to `@show`." },
  { component: "ConnectPanel", from: "empty", fromKind: "prop", to: "emptyLabel", kind: "prop", note: "Use `empty-label` with the same text." },
  { component: "ConnectPanel", from: "oauth", fromKind: "event", to: "authorize", kind: "event", note: "Listen to `@authorize`." },
  { component: "ConnectPanel", from: "copy-command", fromKind: "event", to: "copy", kind: "event", note: "Listen to `@copy`." },
  { component: "ConnectPanel", from: "remove-all", fromKind: "event", to: "clear", kind: "event", note: "Listen to `@clear`." },
  { component: "ConnectProviderRow", from: "oauth", fromKind: "event", to: "authorize", kind: "event", note: "Listen to `@authorize`." },
  { component: "ConnectProviderRow", from: "copy-command", fromKind: "event", to: "copy", kind: "event", note: "Listen to `@copy`." },
  { component: "BrowserSupportNotice", from: "copied", fromKind: "event", to: "copy", kind: "event", note: "Listen to `@copy`. The payload is `{ url }`." },
]

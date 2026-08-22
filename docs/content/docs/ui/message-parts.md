---
title: Message Parts
description: Render the complete AI SDK UIMessage part union with application escape hatches.
navigation.order: 12
navigation.group: Chat
icon: i-lucide-blocks
---

`AgentMessageParts` dispatches the parts already present in an AI SDK `UIMessage`. Text uses `AgentMarkdown`; reasoning and tools use Nuxt UI; files and sources use accessible links.

## Supported parts

| Part                                 | Default rendering                                         |
| ------------------------------------ | --------------------------------------------------------- |
| `text`                               | Streaming-aware Comark Markdown.                          |
| `reasoning`                          | `UChatReasoning`.                                         |
| `tool-*`, `dynamic-tool`             | `UChatTool` with input, output, error, and loading state. |
| `file`                               | Named download or image preview.                          |
| `source-url`, `source-document`      | Source link or document label.                            |
| `step-start`                         | No visual output unless slotted.                          |
| `data-*`, `custom`, `reasoning-file` | `fallback` slot.                                          |

## Customize typed data

```vue
<AgentMessageParts :parts="message.parts">
  <template #fallback="{ part }">
    <WeatherCard
      v-if="part.type === 'data-weather'"
      :weather="part.data"
    />
  </template>
</AgentMessageParts>
```

Use `#part` to intercept every part before the default dispatcher. Use the narrower `#text`, `#reasoning`, `#tool`, `#file`, `#source`, and `#step` slots when only one rendering needs to change.

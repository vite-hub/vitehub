<script setup lang="ts">
const channels = [
  {
    name: "Web chat",
    helper: "webChat()",
    icon: "i-lucide-messages-square",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "HTTP",
    helper: "http()",
    icon: "i-lucide-globe",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "Slack",
    helper: "slack()",
    icon: "i-simple-icons-slack",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "Discord",
    helper: "discord()",
    icon: "i-simple-icons-discord",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "Telegram",
    helper: "telegram()",
    icon: "i-simple-icons-telegram",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "Teams",
    helper: "teams()",
    icon: "i-lucide-users",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "GitHub",
    helper: "github()",
    icon: "i-simple-icons-github",
    to: "/docs/agents/channels#add-a-channel",
  },
  {
    name: "GitLab",
    helper: "gitlab()",
    icon: "i-simple-icons-gitlab",
    to: "/docs/agents/code-host-channels",
  },
  {
    name: "Forgejo",
    helper: "forgejo()",
    icon: "i-simple-icons-forgejo",
    to: "/docs/agents/code-host-channels",
  },
  { name: "Gmail", helper: "gmail()", icon: "i-simple-icons-gmail", to: "/docs/agents/gmail" },
];
</script>

<template>
  <ul
    class="not-prose my-6 grid list-none grid-cols-2 gap-x-6 gap-y-4 p-0 sm:grid-cols-3"
    aria-label="Built-in Agent Channels"
  >
    <li v-for="channel in channels" :key="channel.helper">
      <NuxtLink
        :to="channel.to"
        class="flex items-center gap-2 text-sm text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      >
        <UIcon :name="channel.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span>{{ channel.name }}</span>
      </NuxtLink>
    </li>
  </ul>
</template>

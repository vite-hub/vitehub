<script setup lang="ts">
import { AppShell } from "../app-shell/index.ts";
import { House, Rocket, Settings } from "@lucide/vue";
import type { AppShellGroup } from "../app-shell/index.ts";

const groups: AppShellGroup[] = [
  {
    label: "Project",
    items: [
      { title: "Overview", href: "#overview", icon: House },
      { title: "Deploys", href: "#deploys", icon: Rocket, badge: 12 },
      { title: "Settings", icon: Settings, children: [{ title: "General", href: "#general" }, { title: "Domains", href: "#domains" }] },
    ],
  },
];
</script>

<template>
  <!-- `contain: layout` keeps the fixed sidebar inside this frame. -->
  <div
    data-slot="example-app-shell"
    style="contain: layout; height: 28rem; overflow: hidden; border: 1px solid var(--border); border-radius: 12px"
  >
    <AppShell title="My app" heading="Overview" :groups="groups" current="#overview">
      <p style="margin: 0">The project runs on Cloudflare.</p>
    </AppShell>
  </div>
</template>

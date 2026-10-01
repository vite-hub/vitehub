<script setup lang="ts">
import type { UIMessage } from "ai";

const chart =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fafafa"/><path d="M20 150 L90 110 L160 120 L230 60 L300 40" stroke="#18181b" stroke-width="4" fill="none"/></svg>',
  );

// SAFETY: Every fixture entry below is a concrete AI SDK file or source part.
const parts = [
  { type: "file", filename: "latency.svg", mediaType: "image/svg+xml", url: chart },
  { type: "file", filename: "report.txt", mediaType: "text/plain", url: "data:text/plain,p95%3D180ms" },
  {
    type: "source-url",
    sourceId: "source-1",
    url: "https://vitehub.dev/docs/ui",
    title: "ViteHub UI documentation",
  },
  {
    type: "source-document",
    sourceId: "source-2",
    mediaType: "application/pdf",
    title: "Incident review 2026-08",
  },
] as UIMessage["parts"];
</script>

<template>
  <AgentMessageParts :parts="parts" />
</template>

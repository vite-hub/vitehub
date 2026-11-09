<script setup lang="ts">
type LineVariant = "default" | "added" | "removed";

const files = [
  {
    path: "app/middleware/login.ts",
    added: false,
    additions: 2,
    deletions: 2,
    diff: `@@ -4,6 +4,6 @@
 export default defineNuxtRouteMiddleware((to) => {
   const next = to.query.next;
-  const redirectTo =
-    typeof next === "string" && next.startsWith("/") ? next : "/";
+  const redirectTo = safeRedirect(next);
+
   return navigateTo(redirectTo);
 });`,
  },
  {
    path: "app/utils/safe-redirect.ts",
    added: true,
    additions: 7,
    deletions: 0,
    diff: `@@ -0,0 +1,7 @@
+export function safeRedirect(next: unknown) {
+  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) {
+    return "/";
+  }
+
+  return next;
+}`,
  },
];

function lines(diff: string) {
  return diff.split("\n").map((line) => {
    if (line.startsWith("@@")) return { header: true, text: line, variant: "default" as LineVariant };
    const variant: LineVariant = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "default";
    return { header: false, text: line.slice(1), variant };
  });
}
</script>

<template>
  <Trace class="w-full max-w-sm">
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-git-commit-light" /></TraceIcon>
          <TraceTitle>Committed a1b2c3d: Fix the login redirect</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          <USlideover
            v-for="file in files"
            :key="file.path"
            :title="file.path"
            :description="`${file.additions} additions, ${file.deletions} deletions`"
          >
            <button type="button">
              <TraceLine>
                <TraceIcon><UIcon :name="file.added ? 'i-ph-file-plus-light' : 'i-ph-note-pencil-light'" /></TraceIcon>
                <TraceTitle>{{ file.added ? "Added" : "Edited" }} {{ file.path }}</TraceTitle>
                <TraceDescription class="font-mono">
                  +{{ file.additions }} −{{ file.deletions }}
                </TraceDescription>
                <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
              </TraceLine>
            </button>
            <template #body>
              <CodeBlock>
                <CodeBlockContent>
                  <CodeBlockLine
                    v-for="(line, index) in lines(file.diff)"
                    :key="index"
                    :variant="line.variant"
                    :class="line.header ? 'text-muted' : undefined"
                  >
                    {{ line.text }}
                  </CodeBlockLine>
                </CodeBlockContent>
              </CodeBlock>
            </template>
          </USlideover>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
</template>

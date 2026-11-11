<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const code = `  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Sign in first" });
  }

  const rows = await db.query.projects.findMany({
    where: eq(projects.ownerId, session.user.id),
    orderBy: desc(projects.updatedAt),
  });

  return rows;
});`;

const lines = useHighlightedCode(code, "ts");
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>server/api/projects.get.ts</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent line-numbers :start-line="95">
        <CodeBlockLine v-for="(line, index) in lines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>

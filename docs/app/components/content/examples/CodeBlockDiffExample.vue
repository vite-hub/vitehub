<template>
  <div class="flex w-full max-w-lg flex-col gap-4">
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>package.json</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <CodeBlockLine>"scripts": {</CodeBlockLine>
        <CodeBlockLine variant="removed">  "test": "vitest run"</CodeBlockLine>
        <CodeBlockLine variant="added">  "test": "vp test"</CodeBlockLine>
        <CodeBlockLine>}</CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
    <CodeBlock size="sm" variant="destructive">
      <CodeBlockHeader>
        <CodeBlockTitle>pnpm install --frozen-lockfile</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent wrap>
        ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with packages/ui/package.json
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>

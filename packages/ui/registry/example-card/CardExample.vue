<script setup lang="ts">
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../card/index.ts";
import { Button } from "../button/index.ts";
</script>

<template>
  <div data-slot="example-card" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Card>
      <CardHeader>
        <CardTitle>Production</CardTitle>
        <CardDescription>Deployed 3 minutes ago from main.</CardDescription>
        <CardAction><Button size="xs" variant="ghost" label="Logs" /></CardAction>
      </CardHeader>
      <CardContent>app.example.com</CardContent>
      <CardFooter><Button size="sm" label="Redeploy" /></CardFooter>
    </Card>
  </div>
</template>

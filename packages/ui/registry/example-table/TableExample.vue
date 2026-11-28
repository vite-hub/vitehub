<script setup lang="ts">
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../table/index.ts";

const rows = [
  { branch: "main", status: "Live", age: "3m" },
  { branch: "feat/registry", status: "Building", age: "10m" },
];
</script>

<template>
  <div data-slot="example-table" style="max-width: 32rem">
    <Table>
      <TableCaption>The last deploys.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Age</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="row in rows" :key="row.branch">
          <TableCell>{{ row.branch }}</TableCell>
          <TableCell>{{ row.status }}</TableCell>
          <TableCell>{{ row.age }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<template>
  <ul class="flex flex-col gap-2">
    <li><Status label="Draft" /></li>
    <li><Status tone="success" label="Published" /></li>
    <li><Status tone="warning" label="Queued" /></li>
    <li><Status tone="info" label="Running" pulse /></li>
    <li><Status tone="error" label="Failed" colored /></li>
  </ul>
</template>

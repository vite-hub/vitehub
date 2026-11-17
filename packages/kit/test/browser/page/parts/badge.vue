<template>
  <div data-slot="stack">
    <div data-slot="row">
      <span data-slot="vh-badge">12</span>
      <span data-slot="vh-badge" data-tone="success">ready</span>
      <span data-slot="vh-badge" data-tone="error">unavailable</span>
    </div>
    <div data-slot="row">
      <span data-slot="vh-badge" data-size="sm">Off</span>
      <span data-slot="vh-badge" data-size="sm" data-tone="success">On, implied</span>
      <span data-slot="vh-badge" data-size="sm" data-tone="warning">Unknown</span>
      <span data-slot="vh-badge" data-size="sm" data-tone="info" role="status">Draft</span>
      <span data-slot="vh-badge" data-size="sm" data-tone="error">Protocol error</span>
    </div>
  </div>
</template>

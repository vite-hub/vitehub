<script setup lang="ts">
const signInEmail = useSignIn('email')
</script>

<template>
  <button @click="signInEmail.execute({ email: 'ada@example.com', password: 'correct-horse' })">
    Sign in
  </button>
</template>

<script setup lang="ts">
definePageMeta({ auth: { only: 'guest', redirectTo: '/dashboard' } })

const signInEmail = useSignIn('email')
</script>

<template>
  <button @click="signInEmail.execute({ email: 'ada@example.com', password: 'correct-horse' })">
    Sign in
  </button>
</template>

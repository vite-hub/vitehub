<script setup lang="ts">
import { StarIcon } from "../icons"
import { Rating, RatingItem } from "@vite-hub/kit/rating"
</script>

<template>
  <Rating aria-label="Rating" :default-value="3">
    <RatingItem>
      <StarIcon aria-hidden="true" />
    </RatingItem>
  </Rating>
</template>

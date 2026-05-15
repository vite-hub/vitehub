<script setup lang="ts">
import { navigateTo, useRoute } from "#app/composables/router";

const route = useRoute();
const target = route.fullPath.replace(/^\/blog(?=\/|$)/, "/blogs");

await navigateTo(target, { redirectCode: 301 });
</script>

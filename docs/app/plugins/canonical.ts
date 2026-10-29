import { defineNuxtPlugin, useHead, useRoute } from "#imports";

// One canonical URL per page: the apex host, no trailing slash, and no query such as `?lane=`.
export default defineNuxtPlugin(() => {
  const route = useRoute();

  useHead({
    link: [{
      rel: "canonical",
      href: () => `https://vitehub.dev${route.path.length > 1 ? route.path.replace(/\/+$/, "") : route.path}`,
    }],
  });
});

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname;
  const match = path.match(/^\/docs\/(vite|nitro|nuxt)\/tutorials(?:\/(.*))?\/?$/);

  if (!match) {
    return;
  }

  const [, framework, slug] = match;
  const target = slug ? `/blogs/${framework}/${slug}` : `/blogs/${framework}`;

  return sendRedirect(event, target, 301);
});

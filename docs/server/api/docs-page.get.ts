export default defineEventHandler(async (event) => {
  const { path } = getQuery(event);
  if (typeof path !== "string" || !path) {
    throw createError({ statusCode: 400, statusMessage: "Missing docs path" });
  }

  const page = await queryCollection(event, "docs").path(path).first();
  if (!page) {
    throw createError({ statusCode: 404, statusMessage: "Page not found" });
  }

  return page;
});

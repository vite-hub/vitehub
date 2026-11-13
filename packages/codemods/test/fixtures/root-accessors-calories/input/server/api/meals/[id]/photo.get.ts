import { eq } from "drizzle-orm";
import { defineHandler, getValidatedRouterParams, HTTPError } from "nitro/h3";
import { blob } from "vite-hub/blob";
import { useDatabase } from "vite-hub/database/drizzle";
import { z } from "zod";
import { createMealPhotoPreview } from "../../../utils/meal-photo.ts";

export default defineHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, z.object({
    id: z.string().min(1).max(200).regex(/^[^/\\]+$/),
  }), { decode: true });
  const { db, schema } = useDatabase("default");
  const [meal] = await db.select({ photoPath: schema.meals.photoPath }).from(schema.meals).where(eq(schema.meals.id, id)).limit(1);
  if (!meal?.photoPath) throw HTTPError.status(404, "Meal photo not found");

  const [error, response] = await blob.serve(event, meal.photoPath, {
    cacheControl: "public, max-age=300, must-revalidate",
    transform: {
      key: "meal-preview-v1",
      run: createMealPhotoPreview,
    },
  });
  if (error) {
    if (error.code === "BLOB_NOT_FOUND") throw HTTPError.status(404, "Meal photo not found");
    console.error("[calories] Meal photo preview failed", error);
    throw HTTPError.status(422, "Meal photo preview unavailable");
  }
  return response;
});

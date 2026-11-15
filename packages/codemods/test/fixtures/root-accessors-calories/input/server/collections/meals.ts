import { useDatabase } from "vite-hub/database/drizzle";
import { defineCollection, table } from "vite-hub/source";
import database from "../databases/config.ts";

const { db } = useDatabase("default");
const { schema } = database;

export const meals = defineCollection({
  source: table({
    db,
    defaultLimit: 24,
    maxLimit: 50,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    table: schema.meals,
  }),
  transform({ photoPath, ...meal }: typeof schema.meals.$inferSelect) {
    return {
      ...meal,
      createdAt: meal.createdAt.toISOString(),
      photoUrl: photoPath ? `/api/meals/${encodeURIComponent(meal.id)}/photo` : undefined,
      items: meal.items.map((item) => ({
        calories: item.calories ?? item.kcal ?? 0,
        name: item.name ?? item.item ?? "Food",
        portion: item.portion
          ?? (item.portion_g === undefined ? "Estimated portion" : `${item.portion_g} g`),
        protein: item.protein,
      })),
    };
  },
});

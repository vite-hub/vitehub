import { defineEventHandler } from 'nitro/h3';
import { useAuth } from 'vite-hub/auth/server';

export default defineEventHandler(async (event) => {
  const auth = await useAuth(event);
  return auth.user;
});

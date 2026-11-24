import { defineEventHandler } from 'nitro/h3';

export default defineEventHandler(async (event) => {
  const auth = await useAuth(event);
  return auth.user;
});

export default async function createUser(input: { email: string }) {
  return { email: input.email, id: `user:${input.email}` }
}

export default async function sendWelcome(user: { email: string, id: string }) {
  return { userId: user.id, welcomeSent: true }
}

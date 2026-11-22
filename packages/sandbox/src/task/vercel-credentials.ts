export const vercelCredentialEnv = {
  token: { names: ['VITE_SANDBOX_TOKEN', 'VERCEL_TOKEN'], secret: true },
  teamId: { names: ['VITE_SANDBOX_TEAM_ID', 'VERCEL_TEAM_ID'], secret: false },
  projectId: { names: ['VITE_SANDBOX_PROJECT_ID', 'VERCEL_PROJECT_ID'], secret: false },
} as const

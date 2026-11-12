// Local UI review only: `next dev` + DEV_AUTH_BYPASS=1 in .env.local acts as OWNER_EMAIL.
// Dead in every deployed build: NODE_ENV is "production" there and VERCEL is set.
export function devBypassEmail(): string | null {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL) return null;
  if (process.env.DEV_AUTH_BYPASS !== "1") return null;
  return process.env.OWNER_EMAIL?.trim().toLowerCase() || null;
}

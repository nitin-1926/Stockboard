import { createAuthClient } from "better-auth/react";

// Same-origin: the API lives at /api/auth on this app, so no baseURL is needed.
export const authClient = createAuthClient();

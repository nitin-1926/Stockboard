import { Pool } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// One WebSocket Pool for everything (reads, interactive transactions, Better Auth).
// Node 22 has a global WebSocket, so no `ws` package. See docs/adr/0004.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool);

export const db = drizzle({ client: pool, schema });

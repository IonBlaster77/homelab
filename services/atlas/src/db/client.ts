import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** Connects and applies any pending migrations (versioned SQL in ./migrations). */
export async function connect(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, pool };
}

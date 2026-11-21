// drizzle-kit: `npm run db:generate` compares src/db/schema.ts with the last
// migration and writes the SQL for the difference. No database connection is
// needed to generate; the collector applies migrations on start.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});

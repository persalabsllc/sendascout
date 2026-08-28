import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.log("DATABASE_URL is not present; skipping database migrations.");
} else {
  const database = drizzle(neon(connectionString));
  await migrate(database, { migrationsFolder: "./db/migrations" });
  console.log("Database migrations are current.");
}

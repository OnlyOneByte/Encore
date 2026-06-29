import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/server/db/schema.ts into ./drizzle.
//   bun --bun drizzle-kit generate   # author a migration from schema changes
//   (migrations are applied programmatically at boot — see db/migrate.ts)
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/server/db/schema.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.DATA_DIR ? `${process.env.DATA_DIR}/encore.sqlite` : './data/encore.sqlite' }
});

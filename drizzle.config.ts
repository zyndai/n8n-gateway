import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Only the Gateway's own tables. dashboard.ts is intentionally excluded (G12).
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Belt and braces: never touch the dashboard's tables or anything else in the shared DB.
  tablesFilter: ['n8n_*'],
  // Drizzle keeps its journal in its own "drizzle" schema, so it cannot collide with the
  // dashboard's migration table.
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
});

import { envPositiveInteger, envValue } from "../../packages/shared/env";

const databaseUrl = envValue(process.env, "DATABASE_URL", "POSTGRES_URL");
const dbPoolMax = envPositiveInteger(process.env, ["DB_POOL_MAX", "CHATVIEW_DB_POOL_MAX"], 5);

if (!databaseUrl) {
  throw new Error("DATABASE_URL or POSTGRES_URL is required for the chatview backend");
}

const SQL = (Bun as any).SQL;
export const sql = new SQL(databaseUrl, {
  max: dbPoolMax,
});

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    await sql.close?.(0);
  });
}

export async function prepareDatabase() {
  const { assertDatabaseReady, migrationsEnabled, runMigrations } = await import("./migrations");

  if (migrationsEnabled()) {
    await runMigrations(sql);
    return;
  }

  await assertDatabaseReady(sql);
}

export function toId(value: unknown) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export function toNumber(value: unknown) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value ?? 0);
}

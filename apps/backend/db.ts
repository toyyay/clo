const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL or POSTGRES_URL is required for the chatview backend");
}

const SQL = (Bun as any).SQL;
export const sql = new SQL(databaseUrl);

export async function ensureSchema() {
  const schema = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
  const statements = schema
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

export function toId(value: unknown) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export function toNumber(value: unknown) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value ?? 0);
}

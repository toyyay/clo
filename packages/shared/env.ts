export type EnvSource = Record<string, string | undefined>;

export function envValue(env: EnvSource, ...names: string[]) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function envFlag(env: EnvSource, names: string[], fallback = false) {
  const value = envValue(env, ...names);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envPositiveInteger(env: EnvSource, names: string[], fallback: number) {
  const value = envValue(env, ...names);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

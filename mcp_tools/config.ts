export function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export function envOptional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export function envList(prefix: string): string[] {
  const keys: string[] = [];
  // e.g. TAVILY_API_KEY_1, TAVILY_API_KEY_2, ...
  for (let i = 1; i <= 20; i++) {
    const val = process.env[`${prefix}_${i}`];
    if (!val) break;
    keys.push(val);
  }
  // also check base key without suffix
  const base = process.env[prefix.replace(/_\d+$/, "")];
  if (base && !keys.includes(base)) keys.unshift(base);
  return keys;
}

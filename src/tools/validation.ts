export function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Tool input must be a JSON object");
  }
  return input as Record<string, unknown>;
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Field '${key}' must be a string`);
  return value;
}

export function requireStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Field '${key}' must be an array of strings`);
  }
  return value as string[];
}

import { join, resolve } from "node:path";

export const installRoot = resolve(import.meta.dir, "../..");

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const rawValue = line.slice(equals + 1).trim();
    const quoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));
    values[key] = quoted && rawValue.length > 1 ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

// The global `andi` command runs from arbitrary workspaces whose own project
// root controls Bun's automatic .env loading, so the installation's .env is
// applied here as a fallback. Real environment variables always win.
export async function applyInstallEnv(
  env: Record<string, string | undefined> = process.env,
  root: string = installRoot,
): Promise<void> {
  const file = Bun.file(join(root, ".env"));
  if (!(await file.exists())) return;
  for (const [key, value] of Object.entries(parseEnvFile(await file.text()))) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}

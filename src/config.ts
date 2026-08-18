export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTurns: number;
  maxContextChars: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const apiKey = env.AGNES_API_KEY?.trim() || env.AGENT_API_KEY?.trim() || "";
  if (apiKey.length === 0) {
    throw new Error("Missing AGNES_API_KEY. Copy .env.example to .env and set it.");
  }

  const maxTurns = Number(env.AGENT_MAX_TURNS ?? "12");
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("AGENT_MAX_TURNS must be a positive integer");
  }

  const maxContextChars = Number(env.AGENT_MAX_CONTEXT_CHARS ?? "120000");
  if (!Number.isInteger(maxContextChars) || maxContextChars < 1) {
    throw new Error("AGENT_MAX_CONTEXT_CHARS must be a positive integer");
  }

  return {
    apiKey,
    model: env.AGENT_MODEL?.trim() || "agnes-2.5-flash",
    baseUrl: env.AGENT_BASE_URL?.trim() || "https://apihub.agnes-ai.com/v1",
    maxTurns,
    maxContextChars,
  };
}

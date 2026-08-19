export interface ExaConfig {
  apiKey: string;
  baseUrl: string;
}

export type AgentProvider = "agnes" | "minimax";

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AgentConfig {
  provider?: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTurns: number;
  maxContextChars: number;
  exa?: ExaConfig;
  providers?: Partial<Record<AgentProvider, ProviderConfig>>;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const requestedProvider = env.AGENT_PROVIDER?.trim().toLowerCase();
  const provider = (requestedProvider ||
    (env.AGNES_API_KEY?.trim() || env.AGENT_API_KEY?.trim() ? "agnes" : "minimax")) as AgentProvider;
  if (provider !== "agnes" && provider !== "minimax") {
    throw new Error("AGENT_PROVIDER must be 'agnes' or 'minimax'");
  }
  const agnesApiKey = env.AGNES_API_KEY?.trim() || (provider === "agnes" ? env.AGENT_API_KEY?.trim() : "") || "";
  const minimaxApiKey =
    env.MINIMAX_API_KEY?.trim() || (provider === "minimax" ? env.AGENT_API_KEY?.trim() : "") || "";
  const apiKey = provider === "minimax" ? minimaxApiKey : agnesApiKey;
  if (apiKey.length === 0) {
    throw new Error(
      `Missing ${provider === "minimax" ? "MINIMAX_API_KEY" : "AGNES_API_KEY"}. Copy .env.example to .env and set it.`,
    );
  }

  const maxTurns = Number(env.AGENT_MAX_TURNS ?? "12");
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("AGENT_MAX_TURNS must be a positive integer");
  }

  const maxContextChars = Number(env.AGENT_MAX_CONTEXT_CHARS ?? "120000");
  if (!Number.isInteger(maxContextChars) || maxContextChars < 1) {
    throw new Error("AGENT_MAX_CONTEXT_CHARS must be a positive integer");
  }

  const exaApiKey = env.EXA_API_KEY?.trim();

  const providers: Partial<Record<AgentProvider, ProviderConfig>> = {};
  if (agnesApiKey) {
    providers.agnes = {
      apiKey: agnesApiKey,
      model: provider === "agnes" ? env.AGENT_MODEL?.trim() || "agnes-2.5-flash" : env.AGNES_MODEL?.trim() || "agnes-2.5-flash",
      baseUrl: provider === "agnes" ? env.AGENT_BASE_URL?.trim() || "https://apihub.agnes-ai.com/v1" : env.AGNES_BASE_URL?.trim() || "https://apihub.agnes-ai.com/v1",
    };
  }
  if (minimaxApiKey) {
    providers.minimax = {
      apiKey: minimaxApiKey,
      model: provider === "minimax" ? env.AGENT_MODEL?.trim() || "MiniMax-M2.7" : env.MINIMAX_MODEL?.trim() || "MiniMax-M2.7",
      baseUrl: provider === "minimax" ? env.AGENT_BASE_URL?.trim() || "https://api.minimaxi.com/v1" : env.MINIMAX_BASE_URL?.trim() || "https://api.minimaxi.com/v1",
    };
  }

  return {
    provider,
    apiKey,
    model: env.AGENT_MODEL?.trim() || (provider === "minimax" ? "MiniMax-M2.7" : "agnes-2.5-flash"),
    baseUrl:
      env.AGENT_BASE_URL?.trim() ||
      (provider === "minimax" ? "https://api.minimaxi.com/v1" : "https://apihub.agnes-ai.com/v1"),
    maxTurns,
    maxContextChars,
    providers,
    ...(exaApiKey
      ? {
          exa: {
            apiKey: exaApiKey,
            baseUrl: env.EXA_BASE_URL?.trim() || "https://api.exa.ai",
          },
        }
      : {}),
  };
}

export interface MemoryDocument {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  content: string;
  path: string;
}

export interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  path: string;
}

export interface MemoryMatch extends MemorySummary {
  score: number;
  snippet: string;
}

export interface MemoryWriteInput {
  id: string;
  title: string;
  tags: readonly string[];
  content: string;
  expectedUpdated?: string;
}

export interface MemoryWriteResult {
  action: "created" | "updated";
  memory: MemorySummary;
}

export interface MemoryArchiveResult {
  id: string;
  archivedPath: string;
}

export interface MemoryContext {
  content: string;
  ids: string[];
  chars: number;
  truncated: boolean;
}

export interface MemoryProvider {
  buildContext(query: string, signal?: AbortSignal, maxChars?: number): Promise<MemoryContext>;
}

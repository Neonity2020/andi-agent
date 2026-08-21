export type KnowledgeStatus = "verified" | "reference" | "needs-review";

export interface KnowledgeDocument {
  id: string;
  title: string;
  category: string;
  type: string;
  status: KnowledgeStatus;
  updated: string;
  summary: string;
  tags: string[];
  sources: string[];
  related: string[];
  content: string;
  path: string;
}

export interface KnowledgeMatch {
  id: string;
  title: string;
  category: string;
  status: KnowledgeStatus;
  updated: string;
  summary: string;
  score: number;
  path: string;
}

export interface KnowledgeCaptureInput {
  id: string;
  title: string;
  category: string;
  type?: string;
  status?: KnowledgeStatus;
  summary: string;
  tags: readonly string[];
  sources: readonly string[];
  related?: readonly string[];
  content: string;
  expectedUpdated?: string;
}

export interface KnowledgeCaptureResult {
  action: "created" | "updated";
  document: KnowledgeDocument;
  mocUpdated: boolean;
}

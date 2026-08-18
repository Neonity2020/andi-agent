import type { Message } from "./model/types";

const COMPACTION_NOTICE = "[Earlier conversation turns were omitted to fit the context budget.]";

export interface CompactionResult {
  messages: Message[];
  droppedMessages: number;
}

function messageSize(message: Message): number {
  return JSON.stringify(message).length;
}

export function compactMessages(messages: readonly Message[], maxChars: number): CompactionResult {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");

  const hadCompactionNotice = messages.some(
    (message) => message.role === "system" && message.content === COMPACTION_NOTICE,
  );
  const normalized = messages.filter(
    (message) => !(message.role === "system" && message.content === COMPACTION_NOTICE),
  );
  const systemMessages: Message[] = [];
  let cursor = 0;
  while (normalized[cursor]?.role === "system") {
    systemMessages.push(normalized[cursor] as Message);
    cursor += 1;
  }

  const groups: Message[][] = [];
  for (const message of normalized.slice(cursor)) {
    if (message.role === "user" || groups.length === 0) groups.push([]);
    groups.at(-1)?.push(message);
  }

  const systemSize = systemMessages.reduce((total, message) => total + messageSize(message), 0);
  let used = systemSize;
  const keptGroups: Message[][] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as Message[];
    const groupSize = group.reduce((total, message) => total + messageSize(message), 0);
    if (keptGroups.length > 0 && used + groupSize > maxChars) break;
    keptGroups.unshift(group);
    used += groupSize;
  }

  const keptCount = keptGroups.reduce((total, group) => total + group.length, 0) + systemMessages.length;
  const droppedMessages = normalized.length - keptCount;
  if (droppedMessages === 0) {
    return {
      messages: hadCompactionNotice
        ? [...systemMessages, { role: "system", content: COMPACTION_NOTICE }, ...groups.flat()]
        : normalized,
      droppedMessages: 0,
    };
  }

  return {
    messages: [
      ...systemMessages,
      { role: "system", content: COMPACTION_NOTICE },
      ...keptGroups.flat(),
    ],
    droppedMessages,
  };
}

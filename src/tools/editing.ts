import type { Tool } from "./types";
import { requireRecord, requireString } from "./validation";
import type { Workspace } from "./workspace";
import { throwIfAborted } from "../runtime/abort";

export function createEditTool(workspace: Workspace): Tool {
  return {
    name: "edit_file",
    description:
      "替换工作区现有文件中唯一匹配的精确文本块。请先读取文件，并提供足够的上下文确保 old_text 只出现一次。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于工作区的文件路径" },
        old_text: { type: "string", description: "必须恰好出现一次的原文本" },
        new_text: { type: "string", description: "替换后的文本" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      throwIfAborted(context?.signal);
      const values = requireRecord(input);
      const path = requireString(values, "path");
      const oldText = requireString(values, "old_text");
      const newText = requireString(values, "new_text");
      if (oldText.length === 0) throw new Error("Field 'old_text' cannot be empty");
      workspace.assertToolPath(path);

      const content = await workspace.read(path);
      const firstMatch = content.indexOf(oldText);
      if (firstMatch === -1) throw new Error("old_text was not found in the file");
      if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
        throw new Error("old_text occurs more than once; include more surrounding context");
      }

      const updated = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
      await workspace.write(path, updated);
      throwIfAborted(context?.signal);
      return { edited: path };
    },
  };
}

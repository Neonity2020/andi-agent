import type { Tool } from "./types";
import { requireRecord, requireString } from "./validation";
import type { Workspace } from "./workspace";

export function createEditTool(workspace: Workspace): Tool {
  return {
    name: "edit_file",
    description:
      "Replace one exact, unique text block in an existing workspace file. Read the file first and include enough surrounding text to make old_text unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        old_text: { type: "string", description: "Exact text that must occur exactly once" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    async execute(input: unknown) {
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
      return { edited: path };
    },
  };
}

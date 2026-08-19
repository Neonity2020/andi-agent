---
name: skill-creator
description: Create or update portable Agent Skills in SKILL.md format for this repository. Use when the user asks to build, revise, validate, or package a skill for andi-agent, Claude Code, or Codex.
metadata:
  short-description: Create or update a portable skill
---

# Skill Creator

Create small, reusable skills that improve an agent's decisions for a specific workflow. Preserve the user's requested scope and do not add unrelated configuration, permissions, integrations, or publishing steps.

## Portable layout

Use the canonical project location:

```text
.agents/skills/<skill-name>/SKILL.md
```

The same `SKILL.md` format is also understood from `.claude/skills/<skill-name>/SKILL.md` and legacy `.codex/skills/<skill-name>/SKILL.md`. Prefer one canonical copy under `.agents/skills/` rather than maintaining divergent duplicates.

Use lowercase letters, digits, and hyphens for `<skill-name>`, with fewer than 64 characters. Keep the skill directory focused:

- `SKILL.md` is required.
- Add `references/`, `scripts/`, or `assets/` only when they directly support the workflow.
- Do not add a README, changelog, placeholder examples, or copied manuals unless requested.

## Write the skill

1. Identify the concrete task, trigger phrases, expected outcome, and the boundary where the skill should not apply.
2. Add YAML frontmatter with `name` and a discriminating `description`. Preserve useful optional fields such as `metadata`, `disable-model-invocation`, `user-invocable`, `context`, `allowed-tools`, and `argument-hint` when they are part of the requested behavior.
3. Put only decision-changing instructions in `SKILL.md`: workflow, constraints, tool choices, output requirements, and final checks. Move large or conditional material to a linked reference and load it only when needed.
4. Preserve authorization boundaries. A skill may describe a workflow, but it does not grant permission for external writes, destructive operations, secrets, or deployments.
5. Keep automatic invocation enabled unless the user explicitly wants an explicit-only skill. Use `disable-model-invocation: true` for workflows that must run only after the user invokes them.

## Cross-tool compatibility

Prefer the shared syntax supported by both Claude Code and Codex:

- `$ARGUMENTS` for explicit invocation arguments.
- `${CLAUDE_SKILL_DIR}` for files bundled beside `SKILL.md`.
- Relative links to supporting files in the same skill directory.

Claude-style ``!`command` `` dynamic context is allowed when it materially improves the workflow. It must run through the host agent's existing command approval and output limits; never use it to bypass a safety gate. Treat `context: fork` and tool restrictions according to the host agent's capabilities rather than pretending unsupported isolation or permissions exist.

## Validate

Before finishing:

- Confirm the file starts with valid YAML frontmatter and has no unfinished scaffold placeholders.
- Check that the name matches the directory and the description is specific enough to avoid unrelated activation.
- Verify every referenced resource exists and is linked from `SKILL.md`.
- Run the repository's available skill validator or tests when present.
- Report the created/updated path and any host-specific behavior that cannot be represented portably.

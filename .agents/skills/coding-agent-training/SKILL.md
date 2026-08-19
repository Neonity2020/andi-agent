---
name: coding-agent-training
description: Plan, deliver, or coach a training session on building Coding Agents from scratch. Use when the user is preparing training material, exercises, or live demos about Coding Agent construction (prompt + tool + loop + skills + memory). Triggers on phrases like "Coding Agent 培训", "agent 构建课程", "build coding agent training", "teach agent design", "agent 脚手架课程".
metadata:
  short-description: Training material for Coding Agent construction
disable-model-invocation: false
user-invocable: true
argument-hint: "[module-name] [--audience junior|senior|pm] [--duration 2h|halfday|fullday]"
allowed-tools:
  - read_file
  - search_code
  - write_file
---

# Coding Agent Construction Training

A reusable playbook for teaching engineers, PMs, or researchers how to build a Coding Agent from first principles. Use it whenever the user is preparing, rehearsing, or running this training — not for using existing agents.

## Workflow

### 1. Establish context first

Ask the user (or read from input) only what changes the curriculum:

- **Audience**: junior dev / senior dev / PM / mixed
- **Duration and format**: 2h lecture / half-day workshop / full-day build-along / multi-day cohort
- **Pre-existing knowledge**: TypeScript, async I/O, LLM APIs, prompt basics, the andi-agent codebase
- **What "success" looks like**: every learner ships a working minimal agent by the end

If any of those are missing, surface them before writing slides — the answer reshapes scope.

### 2. Teach the "5 pillars" in order

Build up to a real agent in five additive layers. Do not skip a layer; each one solves a real failure mode of the previous.

1. **Prompt** — system instructions + user message + tool descriptions. Show the contract between instructions and behavior. Cover: persona, constraints, output format, refusal rules.
2. **Tool** — typed functions the model can invoke. Always show input schema, output schema, and one example call. Cover: naming, error handling, idempotence, side effects.
3. **Loop** — model → tool call → execute → observation → repeat. Cover: termination conditions, message history, token budgets, cancellation.
4. **Skill** — packaged workflows with YAML frontmatter + decision rules. Cover: trigger phrases, `disable-model-invocation`, references/scripts/assets folder convention.
5. **Memory** — durable context across sessions. Cover: what to remember, what to forget, archive vs overwrite, retrieval tags.

### 3. Hands-on build path

Walk learners through a single TypeScript project (`src/agent.ts` shape) that grows one pillar at a time. Suggested milestones:

| Milestone | New capability | Exercise |
|---|---|---|
| M0 | `callModel(prompt) → string` | "Echo the user's message verbatim" |
| M1 | + `read_file` tool | "List files and show their contents" |
| M2 | + `edit_file` tool with diff check | "Refactor a function across two files" |
| M3 | + `run_command` (sandboxed) | "Run the test suite and summarize failures" |
| M4 | + skill loader (`SKILL.md` parser) | "Invoke `pdf-to-markdown` skill end-to-end" |
| M5 | + memory + handoff | "Resume yesterday's session from a memory note" |

Each milestone should be shippable in 15–30 minutes for a learner who already knows TypeScript.

### 4. Exercises and demos

- **Live coding**: type in front of the class, narrate each decision, intentionally hit one failure and recover.
- **Pair exercise**: two learners swap agents every 20 minutes and try to break each other's.
- **Failure autopsy**: take a real agent trace, mark where the loop diverged, propose a guardrail.
- **Skill authoring**: each learner writes a SKILL.md for a real workflow they own.

### 5. Common pitfalls — teach these by showing, not by telling

- **No tool guardrails** → model deletes `node_modules`. Show the diff and the recovery.
- **Loose tool schemas** → invalid arguments pass through. Show the JSON schema tight enough to reject them.
- **Unbounded loops** → infinite token spend. Show a `maxSteps` + `cancelToken` pattern.
- **Context bloat** → tool outputs explode the prompt. Show a "truncate large tool outputs" rule.
- **Skill description too broad** → wrong skill triggers. Show a discriminating description and a negative example.

## Constraints

- **TypeScript examples** — match the andi-agent codebase shape (`src/agent.ts`, `src/cli.ts`, `src/repl.ts`, `src/skills/manager.ts`).
- **Never bypass command approval** — even in training, every `run_command` example must go through the host agent's approval flow.
- **No live API keys on slides** — use environment variables and a `.env.example`.
- **No production-only patterns** — anything that only makes sense in production (rate limiting, retries, observability) belongs in a "What's next" appendix, not the core path.
- **Bilingual-friendly** — slides may mix Chinese and English; key terms (prompt, tool, loop, skill, memory) stay in English.

## Output Requirements

When asked to produce material, return:

1. **A 5–8 slide outline** matching the pillars + milestones.
2. **One exercise per milestone**, runnable in the andi-agent repo.
3. **A self-assessment checklist** for learners to fill in at the end.
4. **A "next steps" appendix**: testing, evaluation, deployment, cost control.

If a full deck is requested, also include:

- A starter repo layout (`src/`, `test/`, `.agents/skills/`).
- A facilitator script with timing per milestone.
- A learner handout (one page per pillar).

## Boundary

This skill applies ONLY to:

- Designing or running a training on building Coding Agents.
- Drafting slides, exercises, demos, or handouts for that training.
- Reviewing a learner's Coding Agent project for pedagogical feedback.

This skill does NOT apply to:

- Training users on **using** an existing Coding Agent (that's `agent-usage`, separate skill).
- Production architecture reviews, deployment, or observability.
- Evaluating production agent quality.
- Non-Coding-Agent training topics.

## Cross-tool notes

- `${CLAUDE_SKILL_DIR}` resolves to this skill's directory for any bundled references.
- `$ARGUMENTS` accepts `[module-name] [--audience junior|senior|pm] [--duration 2h|halfday|fullday]`.
- If a sub-module grows beyond ~150 lines (e.g., a full slide deck), move it to a linked reference and load it on demand.

## Bundled references

Load these on demand when the user asks for the matching artifact:

- [references/halfday-workshop.md](references/halfday-workshop.md) — complete 4h workshop outline with milestones, exercises, and self-assessment checklist.
- [references/fullday-workshop.md](references/fullday-workshop.md) — full-day version (planned).
- [references/exercises.md](references/exercises.md) — M0–M5 hands-on exercises with starter code (planned).
- [references/facilitator-script.md](references/facilitator-script.md) — minute-by-minute facilitator script (planned).

## Examples

- "设计一个 2 小时 Coding Agent 入门课"
- "我要给团队做 Coding Agent 培训，半天的 workshop"
- "Build a coding agent training outline for senior engineers"
- "Coding Agent 培训的练习题"
- "帮我审一下这份 Coding Agent 培训大纲"
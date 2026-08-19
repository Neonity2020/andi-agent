---
name: new
description: Start a clean coding session — clear the current REPL history, save a handoff note, or switch to a fresh named persistent session. Trigger ONLY when the user explicitly types `/new` or asks to "start a new session", "reset the session", "begin fresh", "fresh conversation". Do NOT auto-trigger for unrelated uses of the word "new" (creating new files, new features, new branches, etc.).
metadata:
  short-description: Start a new coding session
disable-model-invocation: true
user-invocable: true
argument-hint: "[--id <session-id>] [--keep-memory no|yes]"
allowed-tools:
  - read_file
  - run_command
  - memory_search
  - memory_read
  - memory_remember
---

# New Session

A tiny workflow for cleanly starting over inside the andi-agent REPL. When the user invokes `/new`, they want a reset — make sure nothing important is lost, then hand them the right next command.

## 1. Interpret the request

Read `$ARGUMENTS` and classify into one of three intents. If still ambiguous after reading the argument, ask **one** short clarifying question — do not start writing memory or running tools yet.

| Intent | Signals | Default next step |
|---|---|---|
| **Clear current session** | no `--id`, no explicit "switch to named session" | tell the user to type `/clear` |
| **Switch to a named persistent session** | `--id <name>` provided, or user says "switch to session X" / "start a new session named X" | save handoff → tell user to exit and run `andi --session <id>` (or `bun run start -- --repl --session <id>`) |
| **Save and exit only** | user says "I want to quit and pick this up later" | save handoff → tell user to type `/exit` |

For unclassified requests, **prefer the conservative path**: save a handoff note (step 3) before telling the user what to do next, and let them choose.

## 2. Decide whether to save a handoff

Default behavior: **always save a handoff**, unless `--keep-memory no` is passed or the user explicitly says "don't save anything".

The note is what makes `/new` non-destructive — without it, anything not in long-term memory is lost the moment the REPL resets.

Skip the handoff only if the conversation is short, exploratory, or trivially reproducible AND the user opted out. Otherwise, even short sessions are worth a one-paragraph note.

## 3. Write the handoff via `memory_remember`

Before writing, run `memory_search` for the same topic to avoid creating duplicates. If a previous handoff exists for today + topic, update it instead of creating a new one — read it first to obtain `updated`, then pass that value to `memory_remember`.

Conventions:

- **ID**: `session-handoff-<yyyy-mm-dd>-<slug>` where `<slug>` is 2–4 words from the topic (kebab-case).
- **Tags**: `[session-handoff, <topic-slug>]` plus up to 3 retrieval tags the next session will likely search for (e.g., `auth`, `migration`, `bug-fix`).
- **Content** — Markdown body with these sections only:
  - `## Goal` — one sentence.
  - `## Status` — what is done, what is in progress.
  - `## Key files` — workspace-relative paths only, no full contents.
  - `## Decisions` — only durable, non-obvious ones.
  - `## Next step` — one concrete action.
  - `## Context to reload` — which long-term memories to read first, if any.

Hard rules — never include in a handoff:

- API keys, tokens, secrets.
- Raw conversation transcripts.
- Full file dumps or large code blocks.
- Guesses about what the user might want next.

If the topic has nothing worth saving (e.g., "I was just testing"), say so out loud and skip step 3 entirely — do not write empty notes just to fill quota.

## 4. Tell the user the right next command

Print a short, copy-pasteable next step. Do **not** run it yourself — `run_command` cannot safely relaunch the REPL you're already inside, and `/clear` / `/exit` are faster as direct keystrokes. The user runs the next command themselves; that keeps state transitions intentional and reviewable.

| Intent | Suggested message |
|---|---|
| Clear current session | "Type `/clear` to reset this session." + (if handoff saved) "Handoff saved to `<memory-id>`." |
| Switch to named session | "Exit (Ctrl-C or `/exit`) then run `andi --session <id>` (or `bun run start -- --repl --session <id>`)." + handoff note. |
| Save and exit | "Type `/exit`." + handoff note. |

If `--id <name>` was passed, use it verbatim. Otherwise, suggest a default based on the topic (e.g., `auth`, `migration-2026-08`).

## 5. Stop

After printing the next-step message, **stop**. Do not start a new tool call. Do not summarize what just happened. The handoff memory and the printed command are the entire output.

## Constraints

- **Never** auto-run `/clear` or `/exit`. Those are REPL-only commands, and the agent is already inside that REPL.
- **Never** spawn a child REPL via `run_command`. The current process is the REPL; nesting is undefined.
- **Never** overwrite an unrelated memory to force a handoff — always use a unique `session-handoff-*` ID.
- **Never** include secrets, raw transcripts, unredacted file contents, or temporary run logs in the handoff.
- **Never** auto-trigger this skill: `disable-model-invocation: true` is mandatory. If the user mentions "new" anywhere else without the `/new` prefix, this skill must not load.

## Boundary

Applies ONLY to:

- `/new` invocations from the user (with or without `$ARGUMENTS`).
- Plain-language requests that mean "reset our conversation and start over".

Does NOT apply to:

- Creating new files / features / branches / dependencies — use the regular agent loop.
- Loading an existing saved session — use `--session <existing-id>` at startup.
- Switching models or providers — use `/provider` + `/models`.
- Forgetting a specific piece of long-term memory — use `/memory archive <id>` or the `memory_archive` tool.

## Examples

- `/new` → save handoff, suggest `/clear`.
- `/new --id migration` → save handoff under `migration` topic, suggest exit + `andi --session migration`.
- `/new --keep-memory no` → skip handoff entirely, just suggest `/clear`.
- `/new --id feature-x --keep-memory yes` → save handoff, suggest exit + `andi --session feature-x`.
- "Reset our session, we're done with auth" → ask whether to name a new session; on confirmation save handoff under `auth` topic, suggest `/clear` (or exit + `andi --session auth` if they want persistence).
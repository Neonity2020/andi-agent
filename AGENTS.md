# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`. `agent.ts` owns the agent loop, `cli.ts` is the Bun entry point, and `repl.ts` implements persistent sessions. Model transport lives in `src/model/`, coding tools in `src/tools/`, the terminal UI foundation and orchestrator in `src/tui/`, and local scheduled-task parsing, storage, and execution in `src/scheduler/`.

Tests in `test/` mirror source modules, for example `test/agent.test.ts`. Architecture plans belong in `.plans/`. Store durable, non-sensitive Agent memory as Markdown in `.memory/` and manage it through `memory_*` tools. The `docs/` directory is the sandbox for testing the Agent's generation capabilities, including HTML, images, screenshots, and other generated artifacts. Never commit runtime state from `.andi-agent/`.

## Build, Test, and Development Commands

- `bun install` — install dependencies from `bun.lock`.
- `bun run start -- --repl --session dev` — start a persistent coding session.
- `bun run start -- schedule list` — inspect local scheduled tasks.
- `bun test` — run the complete Bun test suite.
- `bun run typecheck` — run strict TypeScript checking without emitting files.
- `bun run test:live` — exercise the real Agnes API and tool-call loop; requires `AGNES_API_KEY`.

## Coding Style & Naming Conventions

Use TypeScript ES modules, two-space indentation, semicolons, and double quotes. Keep strict typing intact; avoid `any` and weakening `tsconfig.json`. Use `PascalCase` for classes and types, `camelCase` for functions and variables, and `snake_case` for model-facing tool names such as `search_code`. Multiword filenames use kebab-case.

No formatter or linter is configured, so match surrounding code and verify whitespace with `git diff --check`.

## Testing Guidelines

Use `bun:test` with `describe` and `test`. Name files `<module>.test.ts`; cover success, validation failure, and security boundaries. Only `test:live` may require credentials. Use temporary directories for filesystem and Git tests and clean them in `afterEach`. Run `bun test` and `bun run typecheck` before submitting.

## Commit & Pull Request Guidelines

The repository history uses Conventional Commit-style subjects, such as `feat: add phase four tools`. Use an imperative `type: summary` subject (`feat:`, `fix:`, `test:`, `docs:`), and keep each commit focused.

Pull requests should explain behavior changes, safety implications, and verification performed. Link relevant issues and update `.plans/` or README documentation when architecture or CLI behavior changes. Include terminal output or screenshots only for user-visible interaction changes.

## Security & Configuration

Copy `.env.example` to `.env`; never commit Agnes or Exa API keys. Preserve workspace path checks, command approval gates, output limits, and Git safeguards. Do not put secrets, raw transcripts, or temporary run data in `.memory/`; treat all `.andi-agent/` sessions and run logs as sensitive local state.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- devlog-discipline -->

## Devlog discipline

This repo maintains an append-only `DEVLOG.md` at the root. Every substantive change you make must land with a new entry at the top of its `## Log` section, written **in the same session as the change**.

What counts as substantive: bug fixes, features, refactors with observable behavior, build/CI changes, docs that change facts. What does not: whitespace, typo fixes, doc link renames.

Entry shape is defined at the top of `DEVLOG.md`. Use it verbatim — type, scope, reasoning, implementation summary, optional follow-ups. Capture *why* and *tradeoffs*, not *what* — the diff already records what.

Before declaring any task done, verify: if you modified any tracked file in this session and didn't append a DEVLOG entry, you are not done. The log exists to make future agents (and humans) faster — skipping it leaks the most valuable context (the *why*) the moment the session ends.

<!-- /devlog-discipline -->

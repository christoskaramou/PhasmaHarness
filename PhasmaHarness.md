# Project instructions

This is the shared entry point for every agent launched by Harness in this workspace.

## Working rules

- Inspect relevant live source before editing. Preserve unrelated changes. Run focused checks and report what was actually verified.
- Keep project rules in PhasmaHarness.md. Do not create parallel AGENTS.md, CLAUDE.md or other provider instruction files.

## Project knowledge

Use the active workspace wiki index supplied by Harness with each worker request (Settings > Wiki). Its location can change; do not create a competing wiki here. Search focused pages with project_context when available, then verify claims in live source. Do not load the whole wiki.

## Improving these instructions

After a recurring correction, verified pitfall, or workflow change, propose a small update with supporting source references and a verification date. Keep this entry short; put detailed architecture and decisions in the wiki. Remove obsolete or duplicate guidance when proposing replacements. Apply updates only when the user authorizes them. Do not store secrets, raw conversations, or session diaries.

## Imported project rules

The sections below preserve existing project guidance. Apply scoped rules only inside that workspace subfolder; paths in those sections are relative to that scope. Deeper scopes override parent scopes. Maintain these rules here; old entry filenames and mirror-sync instructions refer to this consolidated file. The active wiki supplied by Harness replaces old docs/wiki pointers.

### Workspace scope: .

Imported from: INSTRUCTIONS.md

# Project instructions

This is the shared entry point for every model working in this workspace.

## Working rules

- Read applicable AGENTS.md, CLAUDE.md and other provider/project instructions. Preserve them. If rules conflict, identify the conflict rather than silently replacing rules.
- Inspect relevant live source before editing. Preserve unrelated changes. Run focused checks and report what was actually verified.

## Project knowledge

Use the active workspace wiki index supplied by Harness with each worker request (Settings > Wiki). Its location can change; do not create a competing wiki here. Search focused pages with project_context when available, then verify claims in live source. Do not load the whole wiki.

## Improving these instructions

After a recurring correction, verified pitfall, or workflow change, propose a small update with supporting source references and a verification date. Keep this entry short; put detailed architecture and decisions in the wiki. Remove obsolete or duplicate guidance when proposing replacements. Apply updates only when the user authorizes them. Do not store secrets, raw conversations, or session diaries.

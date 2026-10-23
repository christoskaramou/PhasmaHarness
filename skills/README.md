# Bundled skills

The repo contains these skills. Workers get a short defaults block and an index (src/worker-instructions.cjs) and read a full body on demand via router_read_output {"skill": "<name>"}. Caveman is opt-in. No global skill folder is required.

- caveman and i-have-adhd: full installed texts copied on 2026-09-23, metadata retained. The latter declares MIT. Its medical assumption is overridden by the Harness wrapper.
- ponytail: full skill from plugin 4.10.0, with upstream MIT LICENSE.
- large-responses: full installed skill with a Node standard-library helper (ported from the original Python one). Personal paths replaced by {{SKILL_DIR}}, resolved against the package directory returned by the skill reader when running commands; retained in editable source.
- workflow: existing Harness/global instructions made repository-owned.
- rtk: instructions for the RTK executable bundled in ../tools/bin (see ../tools/manifest.json).
- test-pool: one regression test per solved problem in the project's .testpool/catalog.json; scripts/testpool.cjs picks tests after each reply (path rules + Jev) and runs them from a Stop hook. scripts/install.cjs installs the skill and hooks globally for Claude Code, Codex and Cursor.

Existing project_context and Jev implementations stay in src/workspace and src/providers. No stale PE-only skill paths or duplicate router. Unrelated global plugins are not installed. Preserve skills/ in app archives.

Workspace skill comparisons use a complete candidate folder (`SKILL.md` and any supporting files) for an existing named skill. The existing Hub `compare` tool accepts `target: "skill"`, `skill`, `candidatePath`, `task` and a short `change` summary. Checks must be configured and the owner needs Workspace or Full access. Candidates must be in ignored, untracked project folders. Each run gets frozen packages indexed by their SKILL.md descriptions, with the same on-demand loading as normal work. Editable source retains frontmatter and {{SKILL_DIR}}. Accepted packages live beside the workspace's AppData wiki, under `skills/`, and resolve through the same provider index and `router_read_output` tool. They take effect on subsequent turns without restarting and survive installation updates. Undo restores the prior revision or removes the override to follow bundled updates; conflicting edits are preserved. Finished snapshots are cleaned up, and previous versions are retained for the existing 50-comparison Undo history. Damaged overrides fall back with a notice. The trusted Harness test-pool runner and external CLI Stop hooks are separate and are not replaced by adopting a worker skill. Bundled defaults are never modified.

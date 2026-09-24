# Bundled skills

The repo contains these skills and loads full bodies by default. YAML discovery metadata is omitted from worker prompts. No global skill folder is required.

- caveman and i-have-adhd: full installed texts copied on 2026-09-23, metadata retained. The latter declares MIT. Its medical assumption is overridden by the Harness wrapper.
- ponytail: full skill from plugin 4.10.0, with upstream MIT LICENSE.
- large-responses: full installed skill with a Node standard-library helper (ported from the original Python one). Personal paths replaced by {{SKILL_DIR}}, resolved relative to this installation.
- workflow: existing Harness/global instructions made repository-owned.
- rtk: instructions for the RTK executable bundled in ../tools/bin (see ../tools/manifest.json).

Existing project_context and Jev implementations stay in src/workspace and src/providers. No stale PE-only skill paths or duplicate router. Unrelated global plugins are not installed. Preserve skills/ in app archives.

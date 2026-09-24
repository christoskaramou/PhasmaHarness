# Installer downloads

Setup puts the npm package cache and the Electron download cache here. Downloads stay local and are Git-ignored.

Node and Git are installed through Microsoft WinGet when missing or unusable. WinGet manages downloads and manifest hash checks. Microsoft App Installer/WinGet is the Windows prerequisite.

RTK and ripgrep are not installed system-wide: `tools/fetch.cjs` downloads the builds pinned in `../tools/manifest.json` into `../tools/bin` and verifies their SHA256.

Provider CLIs (Codex, Claude Code, Cursor) are optional and installed from the app's Settings → Providers with each vendor's official installer (see `../src/providers/install.cjs`).

This cache is not a complete offline bundle. Skills and the Node large-response helper already ship under ../skills. Never store credentials here.

Sources: https://github.com/rtk-ai/rtk/releases ; https://github.com/BurntSushi/ripgrep/releases ; https://learn.microsoft.com/windows/package-manager/winget/

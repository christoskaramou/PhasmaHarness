# Phasma Harness

Windows desktop client for local coding agents. One chat can use the Codex CLI you are already signed in to, plus Claude Code and Cursor CLI on their own accounts. Smart routing can pick a model, or you can choose one.

## Requirements

- Windows
- Node.js 22 or newer
- Codex CLI 0.153.4 or newer, signed in with `codex login`

Claude Code and Cursor are optional. Jev is optional and uses a key you save in Settings.

## Run

```
npm ci
npm start
```

`Launch Phasma Harness.vbs` opens the app without a command window after dependencies are installed.

`Install Phasma Harness.cmd` installs missing Node.js LTS and Git through winget, installs Codex CLI 0.153.4 if it is missing, runs `npm ci`, checks the Codex connection, and creates a desktop shortcut. Keep the folder where the shortcut points.

Sessions and settings are stored in `%APPDATA%\Phasma Harness`. The app uses your existing Codex, Claude, and Cursor logins. It does not copy those credentials.

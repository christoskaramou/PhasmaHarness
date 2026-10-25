# Chat copy and paste

Desktop right-click menus use Electron's native Copy and Paste roles, installed by `src/text-context-menu.cjs` from `src/main.cjs`. Selected report text is copyable; Paste is enabled only for an editable target with Chromium's `canPaste` flag. Read-only and disabled composers stay locked. Blank non-text areas keep their existing behavior, including the sidebar's agent menu. The browser UI keeps its browser-native text menu.

The existing message Copy button returns the asynchronous clipboard write through IPC, so a clipboard rejection reaches the renderer rather than showing success early.

Electron 44 uses asynchronous `clipboard.read()`/`write()` and `ClipboardItem`; old synchronous `readHTML()`/`readRTF()` methods are unavailable. Clipboard test backups must materialize each MIME payload into a new `ClipboardItem` before changing the clipboard; objects returned by `read()` cannot be passed directly to `write()`.

Verified 2026-10-24: `tests/text-context-menu-check.cjs`, run by `tests/ui-startup-smoke.cjs`, sends real right-click input to a selected report and editable, read-only and disabled fields. It checks menu roles and enabled states, exercises native copy/paste, and restores the clipboard. The full UI smoke passed. Test windows use isolated temporary stores and no provider inference.

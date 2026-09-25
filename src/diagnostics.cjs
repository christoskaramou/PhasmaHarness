// Plain-text diagnostics for bug reports: versions, provider state, settings that affect behavior, active limits
// and recent log lines. No prompts, replies, file contents, keys, emails or session titles.
const { redact } = require('./log.cjs');

function yesNo(value) { return value ? 'yes' : 'no'; }

function buildDiagnostics({ controller, app = {}, cli = {}, logLines = [] }) {
  const s = controller.data.settings;
  const catalog = controller.catalog();
  const enabled = provider => catalog.filter(p => (p.provider || 'codex') === provider && p.enabled !== false).length;
  const limits = controller.limits?.active?.() || {};
  const lines = [
    `Phasma Harness ${app.version || '?'} · Electron ${app.electron || '?'} · Node ${app.node || process.version} · ${app.platform || process.platform} ${app.arch || process.arch} ${app.osRelease || ''}`.trim(),
    `Packaged: ${yesNo(app.packaged)} · data: ${app.dataLocation || '?'}`,
    '',
    `Codex CLI ${cli.codex || '?'} · running: ${yesNo(controller.codex?.connected)} · ChatGPT signed in: ${yesNo(controller.codex?.signedIn)} · used here: ${yesNo(!!controller.account)}${controller.account?.plan ? ` (${controller.account.plan})` : ''} · models enabled: ${enabled('codex')}`,
    `Claude Code ${cli.claude || '?'} · signed in: ${yesNo(controller.claude.status?.loggedIn)} · used here: ${yesNo(s.claudeEnabled)} · models: ${controller.claude.models?.length || 0}${controller.claude.status?.modelsError ? ` · discovery error: ${controller.claude.status.modelsError}` : ''}`,
    `Cursor CLI ${cli.cursor || '?'} · signed in: ${yesNo(controller.cursor.status?.loggedIn)} · used here: ${yesNo(s.cursorEnabled !== false)} · models enabled: ${enabled('cursor-cli')}`,
    ...(s.providers || []).map(p => `API provider ${p.id} · ${hostOf(p.baseUrl)} · enabled: ${yesNo(p.enabled !== false)} · models enabled: ${enabled(p.id)}`),
    '',
    `Routing: ${s.routing} · router: ${s.routerPreset} · effective router: ${controller.effectiveRouter?.()?.id || 'none'} · manual selection: ${s.mode}`,
    `Default access: ${s.access} · Jev key: ${yesNo(controller.smartRouter?.jev?.configured)} · execution block: ${yesNo(controller.data.executionBlock)}`,
    `Sessions: ${controller.data.sessions.length} · busy: ${yesNo(controller.busy)} · connection: ${controller.connection}${controller.error ? ` (${controller.error})` : ''}`,
    `Decision log: ${(() => { const d = controller.trace?.summary?.(); return d ? `${d.turns} turns; wiki additions ${d.wiki.additions} (${d.wiki.assessed} judged, ${d.wiki.unassessable} not assessable)` : 'none'; })()}; wiki check ${controller.data.settings.wikiAssessment ? 'on' : 'off'}, Jev comparison ${controller.data.settings.jevCompare ? 'on' : 'off'}`,
    `Usage limits: ${Object.entries(limits).map(([p, l]) => `${p} until ${new Date(l.until).toISOString()}${l.known ? '' : ' (estimated)'}`).join(', ') || 'none'}`,
    '',
    `Recent log (${logLines.length} lines):`,
    ...logLines,
  ];
  return redact(lines.join('\n'));
}

function hostOf(url) { try { return new URL(url).host; } catch { return '?'; } }

module.exports = { buildDiagnostics };

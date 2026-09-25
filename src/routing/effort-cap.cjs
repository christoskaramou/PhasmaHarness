// Effort cap for automatic routing (the selector next to Auto, and Settings → Routing). Smart and Jev routing are only
// offered workers at or below the cap, so both routers, the "unsure → strongest" escalation and usage-limit failover
// choose within it; a task that continues keeps its model at the highest effort still allowed. Manual picks are not capped.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORT_CAPS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT_CAP = 'high'; // also the recommended level
const rank = effort => EFFORT_ORDER.indexOf(effort);
const modelKey = p => `${p.provider || 'codex'}|${p.model}`;

// A worker fits when it has no effort levels, a level this list does not know, or one at or below the cap.
// "max" is no cap at all (it also keeps anything above max, such as ultra).
function withinCap(p, cap) {
  if (!p?.effort || cap === 'max' || !EFFORT_CAPS.includes(cap)) return true;
  const level = rank(p.effort);
  return level < 0 || level <= rank(cap);
}

// The workers Auto routing may use, in their original order. A model with no level at or below the cap keeps only its
// lowest level, so the cap lowers effort without removing models.
function capCatalog(list, cap) {
  const keep = new Set(list.filter(p => withinCap(p, cap)).map(p => p.id));
  const covered = new Set(list.filter(p => keep.has(p.id)).map(modelKey));
  for (const p of [...list].sort((a, b) => rank(a.effort) - rank(b.effort))) {
    if (covered.has(modelKey(p))) continue;
    keep.add(p.id); covered.add(modelKey(p));
  }
  return list.filter(p => keep.has(p.id));
}

// The same model at the highest effort the list still offers (a continued task after the cap was lowered).
function sameModel(worker, list) {
  return list.filter(p => modelKey(p) === modelKey(worker)).sort((a, b) => rank(a.effort) - rank(b.effort)).at(-1) || null;
}

module.exports = { EFFORT_ORDER, EFFORT_CAPS, DEFAULT_EFFORT_CAP, withinCap, capCatalog, sameModel };

'use strict';
// Auto's model swaps on a bot (src/controller/model-swaps.cjs). The router suggests a worker for each new task
// (smart-router.cjs). A bot that already has a model keeps it unless the suggestion fits this task's difficulty better
// by a wide margin, and that margin grows with the conversation the bot would lose. After a swap, or after the user
// keeps the current model, there is a cooldown. A swap the score supports waits for the user's Swap or Keep current.
// The constants are choices, not calibrations.
const { scorer, atEffort, pickPreset, currentRoute, modelKey } = require('./smart-router.cjs');

// Difficulty score, 0-100: the router's difficulty sets the band, and its other answers nudge within it.
const DIFFICULTY_POINTS = { low: 15, medium: 40, high: 70, xhigh: 90 };
const RISK_POINTS = { low: 0, medium: 2, high: 4, critical: 6 };
const UNCERTAINTY_POINTS = { low: 0, medium: 2, high: 4 };
const KIND_POINTS = { general: -4, mechanical: -4, lookup: -3, review: 0, implementation: 2, debugging: 2, audit: 4, architecture: 4 };
const FILES_PER_POINT = 5, MAX_FILE_POINTS = 4; // changed files in a workspace the task concerns
const MIN_NUDGE = -8, MAX_NUDGE = 10;

// A model's capability is its general-index score as a share of the best offered score (0-100). The capability a task
// needs is 55 + 0.45 × difficulty: 62 at low (15) and 73 at medium (40), the router's adequate shares (0.6 and 0.75),
// then 87 at high (70) and 96 at xhigh (90). Fit is 100 minus the gap: an under-powered model loses 2 points per
// missing point, an over-powered one 0.5 per extra point, so a hard task pulls harder than an easy one.
const required = difficulty => 55 + 0.45 * difficulty;
const UNDER_PENALTY = 2, OVER_PENALTY = 0.5;

// A swap needs the suggestion's fit to beat the current model's by BASE_MARGIN plus the switching cost: one point per
// 1,000 tokens of conversation since the last compaction (at most 25), plus 8 when the provider changes, since another
// provider gets the chat as a quoted handoff rather than its own session.
const BASE_MARGIN = 15, TOKENS_PER_POINT = 1000, MAX_CONTEXT_POINTS = 25, PROVIDER_POINTS = 8;

// After any swap decision Auto suggests nothing for 3 tasks or 30 minutes, whichever ends first. After Keep current,
// it does not suggest the same model again for a similar task (difficulty within 15 points) for 10 tasks or 2 hours.
const COOLDOWN = { tasks: 3, ms: 30 * 60000 };
const DECLINED = { tasks: 10, ms: 2 * 3600000, points: 15 };
// An unanswered question keeps the current model.
const PROMPT_MS = 3 * 60000;
// A redirected task continues the chosen worker's whole session, so of the idle workers that fit, the one with the
// shortest conversation takes it, and one past this many tokens is passed over for a new worker. A choice, not a calibration.
const REUSE_TOKENS = 20000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const label = p => p.label || p.model;

function difficultyScore(assessment = {}, evidence = {}) {
  const base = DIFFICULTY_POINTS[assessment.difficulty] ?? DIFFICULTY_POINTS.medium;
  const files = assessment.workspaceRelevant ? Math.min(MAX_FILE_POINTS, Math.floor((evidence?.changedFiles || 0) / FILES_PER_POINT)) : 0;
  const nudge = (RISK_POINTS[assessment.risk] || 0) + (UNCERTAINTY_POINTS[assessment.uncertainty] || 0) + (KIND_POINTS[assessment.taskKind] || 0) + files;
  return clamp(base + clamp(nudge, MIN_NUDGE, MAX_NUDGE), 0, 100);
}

function fit(capability, difficulty) {
  if (!Number.isFinite(capability)) return null;
  const need = required(difficulty);
  const gap = capability < need ? UNDER_PENALTY * (need - capability) : OVER_PENALTY * (capability - need);
  return Math.round(clamp(100 - gap, 0, 100));
}

// Rough tokens of conversation a model's session holds: messages, commands, tool calls and their output since the last
// compaction. 2026-11-01: a Claude bot's 37 tool calls held 136k characters its messages did not show.
function contextTokens(items = []) {
  let chars = 0;
  for (const item of items.slice(items.findLastIndex(item => item.type === 'contextCompaction') + 1)) {
    if (item.type === 'notice' || item.type === 'toolStep') continue;
    for (const value of [item.text, item.command, item.aggregatedOutput, item.arguments, item.result])
      if (typeof value === 'string') chars += value.length;
      else if (value && typeof value === 'object') chars += JSON.stringify(value).length;
    for (const part of Array.isArray(item.content) ? item.content : []) if (part?.type === 'text' && typeof part.text === 'string') chars += part.text.length;
  }
  return Math.round(chars / 4);
}

const contextPoints = tokens => Math.min(MAX_CONTEXT_POINTS, Math.round(tokens / TOKENS_PER_POINT));

function switchCost(session, from, to) {
  const tokens = contextTokens(session.items);
  const crossProvider = (from.provider || 'codex') !== (to.provider || 'codex');
  const points = contextPoints(tokens) + (crossProvider && tokens ? PROVIDER_POINTS : 0);
  return { tokens, points, crossProvider };
}

// Each model's fit for this difficulty, and the suggestion's gain over the current model.
function measure(current, suggested, difficulty, available) {
  const { score } = scorer(available);
  const best = Math.max(...available.map(score).filter(Number.isFinite));
  const capability = p => Number.isFinite(score(p)) && best > 0 ? Math.round(100 * score(p) / best) : null;
  const side = p => ({ id: p.id, label: label(p), provider: p.provider || 'codex', model: p.model, capability: capability(p), fit: fit(capability(p), difficulty) });
  const from = side(current), to = side(suggested);
  return { from, to, gain: from.fit === null || to.fit === null ? null : to.fit - from.fit };
}

function cooldown(state, suggested, difficulty, now) {
  const last = state?.last;
  if (!last) return null;
  const active = limit => last.tasks < limit.tasks && now - last.at < limit.ms;
  if (active(COOLDOWN))
    return { kind: last.kind, tasksLeft: COOLDOWN.tasks - last.tasks, until: last.at + COOLDOWN.ms };
  if (last.kind === 'declined' && last.to === modelKey(suggested) && Math.abs(difficulty - last.difficulty) <= DECLINED.points && active(DECLINED))
    return { kind: 'similar', tasksLeft: DECLINED.tasks - last.tasks, until: last.at + DECLINED.ms };
  return null;
}

const WAITING = { swapped: 'swapped models', declined: 'was told to keep this model', expired: 'asked about a swap',
  similar: 'was told to keep this model for a similar task' };

// The decision for one new task, or null when there is nothing to decide: the bot's first task, its model is no longer
// offered (disabled, over the effort cap, at a usage limit), or the router's own pick is the same model. `keep` is what
// runs without a swap; `propose` means the score supports asking the user.
function evaluateSwap({ selected, session, available, now = Date.now() }) {
  const assessment = selected?.assessment, route = currentRoute(session);
  if (!assessment || !route?.model || !available.some(p => modelKey(p) === modelKey(route))) return null;
  const current = atEffort(route, assessment.difficulty, available);
  let suggested = selected, keep = current;
  // The router keeps an adequate current model for low and medium work, so its pick for this task alone is the suggestion.
  // A setup this project's checks proved for this kind of work is the router's own final choice: nothing to decide.
  if (modelKey(selected) === modelKey(current)) {
    if (selected.proven) return null;
    const fresh = available.find(p => p.id === pickPreset({ ...assessment, reason: '' }, {}, available).preset);
    if (!fresh || modelKey(fresh) === modelKey(current)) return null;
    suggested = fresh; keep = selected;
  }

  const difficulty = difficultyScore(assessment, selected.router?.evidence);
  const { from, to, gain } = measure(current, suggested, difficulty, available);
  const context = switchCost(session, current, suggested);
  const margin = BASE_MARGIN + context.points;
  const blocked = cooldown(session.modelSwapState, suggested, difficulty, now);
  const propose = gain !== null && gain >= margin && !blocked;
  const reason = gain === null ? `Kept ${from.label}: ${from.fit === null ? from.label : to.label} has no measured score, so Auto does not swap.`
    : gain < margin ? `Kept ${from.label}: ${to.label} would fit this task ${gain > 0 ? `better by ${gain}` : 'no better'}, under the ${margin}-point margin for switching.`
      : blocked ? `Kept ${from.label}: ${to.label} fits this task better by ${gain} (margin ${margin}), but Auto ${WAITING[blocked.kind]} recently.`
        : `${to.label} fits this task better by ${gain} points, over the ${margin}-point margin for switching.`;
  return { propose, current, suggested, keep, decision: { difficulty, level: assessment.difficulty, required: Math.round(required(difficulty)),
    current: from, suggested: to, gain, margin, baseMargin: BASE_MARGIN, context, cooldown: blocked, reason } };
}

// Hub's agent_work (controller/model-swaps.cjs): is a task Hub rates at `level` outside the reach of an Auto worker's
// current model, either too hard for it or more than the task needs? The comparison is the model a new Auto worker would
// get for the task. The task does not bring the worker's conversation along, so the margin counts its context points;
// a new worker starts empty on any provider, so there are no provider points. Null: nothing to compare (no model yet, no
// longer offered, the same model, or the model for simple messages, which every worker uses).
function evaluateReach({ level, session, available, autoLowModel = null, proven = [] }) {
  const route = currentRoute(session);
  if (!DIFFICULTY_POINTS[level] || !route?.model || !available.some(p => modelKey(p) === modelKey(route))) return null;
  // A model this project's checks proved for a kind of work wins low and medium work of that kind (smart-router.cjs
  // provenChoice). Hub's rating does not say the kind, so such a model stays at those levels.
  const provenModels = new Set(proven.map(id => available.find(p => p.id === id)).filter(Boolean).map(modelKey));
  if (['low', 'medium'].includes(level) && provenModels.has(modelKey(route))) return null;
  const pick = pickPreset({ difficulty: level, reason: '' }, { autoLowModel }, available);
  if (pick.userPick) return null;
  const current = atEffort(route, level, available), suggested = available.find(p => p.id === pick.preset);
  if (!suggested || modelKey(suggested) === modelKey(current)) return null;

  const difficulty = difficultyScore({ difficulty: level });
  const { from, to, gain } = measure(current, suggested, difficulty, available);
  const tokens = contextTokens(session.items);
  const context = { tokens, points: contextPoints(tokens), crossProvider: false };
  const margin = BASE_MARGIN + context.points;
  const outside = gain !== null && gain >= margin;
  const direction = to.capability > from.capability ? 'hard' : 'easy';
  const task = `this ${level} task (difficulty ${difficulty})`;
  const reason = gain === null ? `Within reach: ${from.fit === null ? from.label : to.label} has no measured score.`
    : !outside ? `Within ${from.label}'s reach: ${to.label} would fit ${task} better by only ${gain}, under the ${margin}-point margin.`
      : `${direction === 'hard' ? `${task[0].toUpperCase()}${task.slice(1)} is beyond ${from.label}` : `${from.label} is more than ${task} needs`}: ${to.label} fits it better by ${gain}, over the ${margin}-point margin.`;
  return { outside, current, suggested, decision: { difficulty, level, required: Math.round(required(difficulty)), current: from, suggested: to,
    gain, margin, context, direction, reason } };
}

// Hub's own model on Auto (controller/model-swaps.cjs), after a request Hub rated at `level` for itself: the model a fresh
// pick for that level would be, from Hub's eligible models (Low or Medium effort), against the current one. Every Hub
// request carries its context (summary and recent messages); a new model gets all of it at once instead of what changed
// (smart-router.cjs completeOnce), so nothing is lost and the margin is the base margin. The cooldowns are a bot's.
function evaluateHubSwap({ current, level, available, state, now = Date.now() }) {
  if (!DIFFICULTY_POINTS[level] || !current || !available.some(p => p.id === current.id)) return null;
  const suggested = available.find(p => p.id === pickPreset({ difficulty: level, reason: '' }, {}, available).preset);
  if (!suggested || modelKey(suggested) === modelKey(current)) return null;

  const difficulty = difficultyScore({ difficulty: level });
  const { from, to, gain } = measure(current, suggested, difficulty, available);
  const blocked = cooldown(state, suggested, difficulty, now);
  const propose = gain !== null && gain >= BASE_MARGIN && !blocked;
  const task = `requests like this (${level}, difficulty ${difficulty})`;
  const reason = gain === null ? `Kept ${from.label}: ${from.fit === null ? from.label : to.label} has no measured score, so Auto does not swap.`
    : gain < BASE_MARGIN ? `Kept ${from.label}: ${to.label} would fit ${task} ${gain > 0 ? `better by ${gain}` : 'no better'}, under the ${BASE_MARGIN}-point margin.`
      : blocked ? `Kept ${from.label}: ${to.label} fits ${task} better by ${gain}, but Auto ${WAITING[blocked.kind]} recently.`
        : `${to.label} fits ${task} better by ${gain} points, over the ${BASE_MARGIN}-point margin.`;
  return { propose, current, suggested, decision: { hub: true, difficulty, level, required: Math.round(required(difficulty)), current: from, suggested: to,
    gain, margin: BASE_MARGIN, baseMargin: BASE_MARGIN, context: { tokens: 0, points: 0, crossProvider: false }, cooldown: blocked, reason } };
}

// Every evaluated new task counts toward the cooldown; a decision starts a new one.
function countTask(session) {
  if (session.modelSwapState?.last) session.modelSwapState.last.tasks++;
}

function recordDecision(session, kind, result, now = Date.now()) {
  session.modelSwapState = { last: { kind, at: now, tasks: 0, from: modelKey(result.current), to: modelKey(result.suggested), difficulty: result.decision.difficulty } };
}

module.exports = { evaluateSwap, evaluateReach, evaluateHubSwap, difficultyScore, fit, required, contextTokens, switchCost, cooldown, countTask, recordDecision,
  BASE_MARGIN, COOLDOWN, DECLINED, PROMPT_MS, REUSE_TOKENS };

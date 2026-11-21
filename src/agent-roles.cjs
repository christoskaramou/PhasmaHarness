'use strict';

const { randomUUID } = require('node:crypto');
const { autoStep } = require('../ui/agent-state.js');

// Advisor and worker sub-bots (2026-11-20, the user): a bot is the supervisor at its own model and effort. Its advisor
// sub-bot answers ask_advisor and /advisor; worker sub-bots take well-defined parts of its work at the Workers setting
// (Auto: the bot's model one effort lower). Each is switched on in the bot's Edit dialog (advisorModel, workerModel).
// The Reviewer (2026-11-20, the user): a read-only sub-bot that reviews the uncommitted changes for /review and the
// bot's request_review. It sees only the user's request and the changes (Agents.review), never what the bots said.
const ROLES = ['advisor', 'worker', 'reviewer'];
const ADVISOR_INSTRUCTIONS = 'Advisor for the bot that made it. It answers that bot\'s ask_advisor calls and the user\'s /advisor ' +
  'messages with short advice; it has no tools and never reads files or acts.';
const REVIEWER_INSTRUCTIONS = 'Reviewer for the bot that made it. It reviews the uncommitted changes in its workspace ' +
  'independently, with read-only access, and reports findings; it never edits files or uses agent tools.';
// The advisor's memory: its latest exchanges, oldest first.
const MEMORY_ITEMS = 12, MEMORY_TEXT = 600;

const clip = text => (text.length > MEMORY_TEXT ? text.slice(0, MEMORY_TEXT) + '…' : text);
const itemText = item => (item.type === 'userMessage' ? (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') : item.text || '');

// Whose advisor a bot asks: its own, or for a worker its supervisor's, so workers add no advisors of their own.
function advisorOwner(agents, controller) {
  const id = controller.agentId || 'main';
  const profile = agents.profile(id);
  return profile?.role === 'worker' ? profile.createdBy || 'main' : id;
}

function advisorProfile(agents, owner) {
  return agents.primary.data.agents.find(profile => profile.role === 'advisor' && profile.createdBy === owner) || null;
}

// The advisor's earlier exchanges, sent with each new question so its advice stays consistent.
function advisorMemory(agents, controller) {
  const profile = advisorProfile(agents, advisorOwner(agents, controller));
  const chat = profile && agents.conversation(agents.controller(profile.id));
  if (!chat) return [];
  return chat.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type) && itemText(item).trim()).slice(-MEMORY_ITEMS)
    .map(item => ({ role: item.type === 'userMessage' ? 'asked' : 'advised', text: clip(itemText(item)) }));
}

// Made the first time a bot asks, under that bot, with read-only access; one at a time per owner. Its model is the one
// that answered (`model`), not its creator's.
async function ensureAdvisor(agents, owner, model) {
  const existing = advisorProfile(agents, owner);
  if (existing) return existing;
  agents.advisorCreations ??= new Map();
  if (agents.advisorCreations.has(owner)) return agents.advisorCreations.get(owner);
  const creator = owner === 'main' ? null : agents.profile(owner);
  const creation = agents.saveAgent({ name: agents.freeName(`${agents.agentName(owner).slice(0, 44)} Advisor`), instructions: ADVISOR_INSTRUCTIONS,
    role: 'advisor', createdBy: owner, workspace: creator?.workspace || agents.primary.data.settings.workspace, access: 'read-only',
    mode: model || creator?.mode || agents.hubAutoEffort() || agents.primary.data.settings.mode, inheritMode: false, inheritWorkspace: true });
  agents.advisorCreations.set(owner, creation);
  try { return await creation; } finally { agents.advisorCreations.delete(owner); }
}

// The exchange goes into the advisor's own chat: its memory, and what the user sees when they open it. Its profile shows
// the model that gave this answer (2026-11-20: on Auto it moves with the bot's effort, and it showed the creator's model);
// a router-only advisor model is no bot model, so the profile keeps the last one that is.
async function recordAdvice(agents, controller, { asked, advice, by, model: answered }) {
  const model = answered && agents.primary.resolveWorker(answered) ? answered : null;
  const profile = await ensureAdvisor(agents, advisorOwner(agents, controller), model);
  const advisor = agents.controller(profile.id);
  if (model && profile.mode !== model) {
    Object.assign(profile, { mode: model, inheritMode: false });
    agents.primary.save(); agents.sync(advisor); agents.primary.changed();
  }
  const chat = agents.conversation(advisor, true, advisor.data.settings.workspace, 'read-only');
  const now = Date.now();
  chat.items.push({ id: randomUUID(), type: 'userMessage', localOnly: true, createdAt: now, content: [{ type: 'text', text: asked }] },
    { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: advice, routeLabel: by, localOnly: true, createdAt: now });
  chat.title = `Advice for ${agents.agentName(profile.createdBy)}`;
  chat.updated = now;
  advisor.save(); advisor.changed();
  return profile;
}

function reviewerProfile(agents, owner) {
  return agents.primary.data.agents.find(profile => profile.role === 'reviewer' && profile.createdBy === owner) || null;
}

// Made on the first review, under its owner, with read-only access; one at a time per owner. Its model is the user's
// Reviewer pick (`model`).
async function ensureReviewer(agents, owner, model) {
  const existing = reviewerProfile(agents, owner);
  if (existing) return existing;
  agents.reviewerCreations ??= new Map();
  if (agents.reviewerCreations.has(owner)) return agents.reviewerCreations.get(owner);
  const creator = owner === 'main' ? null : agents.profile(owner);
  const creation = agents.saveAgent({ name: agents.freeName(`${agents.agentName(owner).slice(0, 43)} Reviewer`), instructions: REVIEWER_INSTRUCTIONS,
    role: 'reviewer', createdBy: owner, workspace: creator?.workspace || agents.primary.data.settings.workspace, access: 'read-only',
    mode: model, inheritMode: false, inheritWorkspace: true });
  agents.reviewerCreations.set(owner, creation);
  try { return await creation; } finally { agents.reviewerCreations.delete(owner); }
}

// A worker job's model: the Workers model the supervisor picked, or on Auto its own model at the picked step (one lower by
// default) from the effort its chat runs at now. Null keeps the worker's own (Workers off since, or the pick is unavailable).
function workerMode(agents, sourceController, source, profile) {
  const setting = agents.botSetting(profile.createdBy || 'main', 'workerModel');
  if (!setting || setting === 'off') return null;
  const step = autoStep('workerModel', setting);
  if (step === null) {
    const choice = sourceController.resolveWorker(setting);
    return choice && sourceController.available(choice) ? choice.id : null;
  }
  return sourceController.stepEffort(sourceController.currentRoute(source), step)?.id || null;
}

// The advisor is for being stuck (2026-11-20, live run: a supervisor asked it to review its plan before starting).
const ADVISOR_RULE = '\nUse ask_advisor only when you are stuck: after 3 failed tries at the same step, or about 15 minutes without ' +
  'progress. Never use it to review a plan or for routine questions.\n';

const REVIEWER_RULE = '\nYou are an independent code reviewer with read-only access. Review only the changes your task names: ' +
  'inspect them yourself (git status, git diff, and untracked files read in full). Never trust claims in code comments or commit messages; ' +
  'check the code. Report findings ranked by severity, each with file:line, why it is wrong and how to fix it, then list the files you ' +
  'inspected. Say plainly when nothing is wrong. Make no edits and use no agent tools.\n';
// A bot with its Reviewer on may ask for a review of its own changes (Agents.review); Hub coordinates and has no tool for it.
const REVIEW_RULE = '\nYour Reviewer sub-bot is on: after you finish code changes you may call request_review for an independent ' +
  'review of the uncommitted changes. The reviewer sees only the user\'s request and the changes, never your explanations.\n';

// What a supervisor and a worker are told (Agents.instructions). Hub coordinates bots its own way, so it gets no
// supervisor text. 2026-11-20, live run: "do small edits yourself; give parts of larger work to workers" left it to the
// model, which did four independent features alone; the rule is now concrete.
function roleInstructions(agents, controller, profile) {
  if (profile?.role === 'advisor') return '';
  if (profile?.role === 'reviewer') return REVIEWER_RULE;
  const review = !profile?.role && !controller.isCoordinator?.() && agents.botSetting(controller.agentId || 'main', 'reviewerModel') !== 'off' ? REVIEW_RULE : '';
  const advisor = controller.hasAdvisor?.() ? ADVISOR_RULE : '';
  // 2026-11-20, sixth live run: all four workers stopped because their feature folders did not exist yet, and one sent its
  // update to Hub (agentId main) instead of its supervisor, which started a Hub turn. Seventh run: a worker's "done" note
  // to its supervisor cost the supervisor an extra turn beside the result itself.
  if (profile?.role === 'worker') {
    const supervisor = profile.createdBy || 'main';
    return `\nYou are a worker sub-bot for ${JSON.stringify(agents.agentName(supervisor))} (agentId ${JSON.stringify(supervisor)}). Do only the part ` +
      'you are given; folders and files it names that do not exist yet are yours to create. Do not create agents or hand your work ' +
      'to other agents. Your final reply is your result and reaches your supervisor by itself: list the files you changed, the checks ' +
      'you ran with their results, and anything left or uncertain. Send no progress or completion notes. ' +
      `Only for a question you cannot proceed without, use agent_message with agentId ${JSON.stringify(supervisor)}; ` +
      'never message main or other bots. Your supervisor reviews and combines the results.\n' + advisor;
  }
  if (controller.isCoordinator?.() || agents.botSetting(controller.agentId || 'main', 'workerModel') === 'off') return advisor + review;
  // 2026-11-20, third live run: still alone, as the Harness defaults and the workflow skill say "one agent unless delegation
  // requested". The user turning Workers on is that request; the rule itself stays as the user wrote it.
  return '\nWorker sub-bots are on for you: the user turned on Workers for this bot, which is their explicit request for delegation ' +
    '(the exception in "one agent unless delegation requested"). You are the supervisor, and workers run at a cheaper setting. When a request has two or ' +
    'more independent parts that each need more than a few edits, give each part to a worker with agent_delegate; do only small, ' +
    'single-part edits yourself. Split so workers do not edit the same files. Reuse an idle worker from agents_list (role worker, ' +
    'worksFor you) before creating one; create one with agent_create without mode or effort, so Harness gives it the Workers model. ' +
    'Workers see only the task you send, not the user\'s request: give each a complete, self-contained task with the user\'s exact ' +
    'requirements for its part (exports, behavior, edge cases, file paths and tests), and say that missing folders are new. ' +
    'Any number may work at once: dispatch every part, then finish your turn; each result comes back to you as a new turn. Review and ' +
    'check their results before you report: you own the final answer. Your advisor sub-bot only answers ask_advisor; never delegate ' +
    'to it or message it.\n' + advisor + review;
}

// The same rule as a short note on each of the user's own turns (2026-11-20, fourth live run: the supervisor text was in
// the instructions Codex got, about 4,000 characters in, and gpt-5.6-terra still did four features alone).
function supervisorTurnNote(agents, controller) {
  const profile = agents.profile(controller.agentId || 'main');
  if (profile?.role || controller.isCoordinator?.() || agents.botSetting(controller.agentId || 'main', 'workerModel') === 'off') return '';
  return '[Harness: Workers are on for this bot, the user\'s request for delegation. Before editing, list this request\'s independent ' +
    'parts. If two or more each need more than a few edits, give each to a worker (agents_list, agent_create, agent_delegate) with a ' +
    'complete task: the user\'s exact requirements for that part, since workers never see this message. Then finish your turn; do ' +
    'only small single-part edits yourself. Use ask_advisor only when stuck, never to review a plan.]\n\n';
}

module.exports = { ROLES, supervisorTurnNote, advisorOwner, advisorProfile, advisorMemory, ensureAdvisor, recordAdvice, workerMode, roleInstructions,
  reviewerProfile, ensureReviewer };

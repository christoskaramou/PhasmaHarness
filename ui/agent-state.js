/** Shared by the runner and renderer so ownership and inheritance cannot diverge. */
var HarnessAgentState = (() => {
  /** @typedef {'read-only'|'workspace-write'|'danger-full-access'} Access */
  /** @typedef {{id:string, name?:string, createdBy?:string, temporaryBatch?:string, role?:'advisor'|'worker', workspace?:string, access?:Access, mode?:string, inheritWorkspace?:boolean, inheritAccess?:boolean, inheritMode?:boolean}} Profile */
  /** @typedef {{id:string, delegation?:{owner?:string, source?:string, delivered?:boolean}}} Chat */
  /** @typedef {{conversationId?:string, sessions:Chat[]}} Context */
  /** @typedef {{agents?:Profile[], agentStates?:Record<string, Context>, executionStates?:Record<string, Context>}} Fleet */
  /** @type {{workspace:'inheritWorkspace', access:'inheritAccess', mode:'inheritMode'}} */
  const INHERITED = { workspace: 'inheritWorkspace', access: 'inheritAccess', mode: 'inheritMode' };

  // Auto effort: a bot's one model, its effort picked for each message by the bot's router. Saved as one mode string.
  const AUTO_EFFORT = 'autoeffort:';
  /** @param {string|undefined} provider @param {string} model */
  const autoEffortMode = (provider, model) => `${AUTO_EFFORT}${provider || 'codex'}:${model}`;
  /** @param {unknown} mode */
  function parseAutoEffort(mode) {
    if (typeof mode !== 'string' || !mode.startsWith(AUTO_EFFORT)) return null;
    const rest = mode.slice(AUTO_EFFORT.length), at = rest.indexOf(':');
    return at > 0 && at < rest.length - 1 ? { provider: rest.slice(0, at), model: rest.slice(at + 1) } : null;
  }
  // Settings each bot has, or takes from its creator (Hub, for a top-level bot) on Inherit, the default.
  const BOT_SETTINGS = { router: ['off', 'jev', 'secondary'], effortCap: ['low', 'medium', 'high', 'xhigh', 'max'] };
  // Auto Advisor and Workers: the bot's model at a step from the effort its turn runs at, within its effort cap. 'chat' is
  // the default step; 'chat:<step>' another (2026-11-20, the user: the step beside Auto can be changed). [value, label, step].
  /** @type {Record<'advisorModel'|'workerModel', [string, string, number][]>} */
  const ROLE_STEPS = {
    advisorModel: [['chat', 'One higher', 1], ['chat:2', 'Two higher', 2], ['chat:max', 'Highest', Infinity], ['chat:0', 'Same as bot', 0]],
    workerModel: [['chat', 'One lower', -1], ['chat:-2', 'Two lower', -2], ['chat:min', 'Lowest', -Infinity], ['chat:0', 'Same as bot', 0]],
  };
  /** The step of an Auto value, or null for Off, a model id or an unknown value. @param {'advisorModel'|'workerModel'} key @param {unknown} value */
  function autoStep(key, value) {
    const entry = ROLE_STEPS[key]?.find(([id]) => id === value);
    return entry ? entry[2] : null;
  }

  /** @param {Profile|null|undefined} profile */
  function isSubBot(profile) {
    // An advisor sub-bot is one also when Hub made it (agent-roles.cjs): it takes no work and no messages.
    return (!!profile?.createdBy && profile.createdBy !== 'main' && !profile.temporaryBatch) || profile?.role === 'advisor';
  }

  /** @param {Profile} profile @param {keyof typeof INHERITED} key @param {Profile[]} profiles @param {string} mainWorkspace */
  function inheritedSource(profile, key, profiles, mainWorkspace) {
    const flag = INHERITED[key];
    /** @type {string[]} */
    const chain = [];
    let current = profile;
    while (current[flag]) {
      const creator = current.createdBy && current.createdBy !== 'main' ? profiles.find(candidate => candidate.id === current.createdBy) : null;
      if (!creator || creator.id === profile.id || chain.includes(creator.id))
        return { chain: [...chain, 'main'], value: { workspace: mainWorkspace, access: 'read-only', mode: 'auto' }[key] };
      chain.push(creator.id);
      current = creator;
    }
    return { chain, value: current[key] };
  }

  /** @param {Fleet|null|undefined} fleet @param {string} id */
  function backgroundView(fleet, id) {
    const background = fleet?.executionStates?.[id];
    const conversation = background?.sessions.find(session => session.id === background.conversationId);
    if (!conversation) return null;
    const job = conversation.delegation;
    const own = fleet?.agentStates?.[id]?.sessions.some(session => session.id === (job?.owner || job?.source));
    return isSubBot(fleet?.agents?.find(agent => agent.id === id)) || (!!job && !job.delivered && !own) ? background || null : null;
  }

  const BUDGETS = 'jobBudgets'; // trimFleet's record of the budgets a receiver holds
  // The desktop window gets a bot's chats only when they changed since it last got them, and everything when full is set;
  // the Main Bot's chats are not repeated at the top level. A chat changed when its revision moved (the bot's
  // sharedRevision, or its own chatRevisions entry for a change confined to it) or its message count or status changed,
  // which also catches edits other bots' code makes. When only some chats changed, just those are sent, with sessionIds
  // giving the full order, and each carries only what changed in it (chatDelta). sent: context key -> chat id -> record.
  // exact: compare every message (command replies); a push compares only the newest when the change was confined to the chat.
  /** @param {any} state @param {Map<string, Map<string, any>>} sent @param {boolean} full @param {boolean} [exact] */
  function trimFleet(state, sent, full, exact = false) {
    if (!state?.agentStates) return state;
    const { sessions, ...trimmed } = state;
    // Job budgets: only those that changed since this receiver last got them (jobBudgetsDelta, merged by keepSessions).
    // All 1,522 of the user's went with every update: 0.56 MB, about 2.6 ms to send and read (2026-11-14).
    if (state.jobBudgets) {
      const previous = sent.get(BUDGETS), texts = new Map(), changed = /** @type {Record<string, any>} */ ({});
      for (const [id, budget] of Object.entries(state.jobBudgets)) {
        const text = JSON.stringify(budget);
        texts.set(id, text);
        if (full || !previous || previous.get(id) !== text) changed[id] = budget;
      }
      sent.set(BUDGETS, texts);
      if (!full && previous) {
        trimmed.jobBudgets = changed; trimmed.jobBudgetsDelta = true;
        const removed = [...previous.keys()].filter(id => !texts.has(id));
        if (removed.length) trimmed.jobBudgetsRemoved = removed;
      }
    }
    for (const group of ['agentStates', 'executionStates']) {
      if (!state[group]) continue;
      trimmed[group] = {};
      for (const [id, context] of Object.entries(state[group])) {
        const key = group + ':' + id, chats = context.sessions || [];
        const shared = context.sharedRevision ?? context.stateRevision;
        const previous = sent.get(key), records = new Map(), changed = [];
        const all = full || !previous || previous.size !== chats.length;
        for (const chat of chats) {
          const own = context.chatRevisions?.[chat.id] || 0;
          const mark = `${chat.items?.length ?? 0}:${chat.status}:${Math.max(shared, own)}`;
          const before = previous?.get(chat.id);
          if (!all && before?.mark === mark) { records.set(chat.id, before); continue; }
          // A full state (the first, a reload, the 10-minute repair) records nothing more, so it never encodes every chat.
          const confined = !exact && before?.shared === shared && before.own !== own && before.status === chat.status;
          const sentChat = full || !previous ? { chat, record: { mark } } : chatDelta(chat, before, { mark, shared, own, status: chat.status }, confined);
          changed.push(sentChat.chat);
          records.set(chat.id, sentChat.record);
        }
        // New records, never edits to the old ones: a reply trims against a copy of sent.
        sent.set(key, records);
        const { sessions: list, ...light } = context;
        if (previous && !full && !changed.length) trimmed[group][id] = { ...light, sessionsKept: true };
        else if (changed.length === chats.length) trimmed[group][id] = { ...light, sessions: changed };
        else trimmed[group][id] = { ...light, sessions: changed, sessionIds: chats.map((/** @type {any} */ chat) => chat.id) };
      }
    }
    return trimmed;
  }

  // A resent chat carries only what changed since this receiver last got it (2026-11-12, the user): a streaming chat of
  // 5,500 messages went whole on every update, 5.9 MB, about 8 ms to send and 11 ms to read, up to ten times a second.
  //   items: the changed and new messages, merged into the receiver's copy by message id; itemsFrom and itemCount check
  //     that copy. A chat whose earlier messages were removed or reordered, or lack unique ids, goes whole.
  //   routes, tasks: changed entries by position (listChanges), as long as neither list got shorter.
  //   other fields: those whose value changed; removedFields names the ones that went.
  // Values are compared as JSON. A change confined to one chat (streamed text, a group reply's copy, its queue) touches
  // only its newest entries, so then only the last TAIL are compared: about 0.1 ms, against 5 ms for every message.
  const TAIL = 50, LISTS = ['routes', 'tasks'];
  /** @param {any[]} values @param {string[]} texts @param {boolean} confined */
  function compareList(values, texts, confined) {
    const from = confined ? Math.max(0, Math.min(texts.length, values.length) - TAIL) : 0;
    const next = texts.slice(0, from), changed = [];
    for (let index = from; index < values.length; index++) {
      const text = JSON.stringify(values[index]) ?? 'null';
      next.push(text);
      if (index >= texts.length || text !== texts[index]) changed.push(index);
    }
    return { texts: next, changed };
  }
  /** @param {any} chat @param {any} before @param {any} record @param {boolean} confined */
  function chatDelta(chat, before, record, confined) {
    const items = chat.items || [], ids = items.map((/** @type {any} */ item) => item?.id);
    const listed = (/** @type {string} */ name) => Array.isArray(chat[name]);
    const fields = new Map(Object.entries(chat)
      .filter(([name, value]) => name !== 'items' && !(LISTS.includes(name) && Array.isArray(value)) && value !== undefined)
      .map(([name, value]) => [name, JSON.stringify(value)]));
    const usable = !!before?.texts && ids.every((/** @type {any} */ id) => typeof id === 'string') && new Set(ids).size === ids.length &&
      items.length >= before.ids.length && before.ids.every((/** @type {string} */ id, /** @type {number} */ index) => ids[index] === id) &&
      LISTS.every(name => !listed(name) || (before.lists[name] && chat[name].length >= before.lists[name].length));
    const itemTexts = compareList(items, usable ? before.texts : [], usable && confined);
    /** @type {Record<string, {texts: string[], changed: number[]}>} */
    const lists = Object.fromEntries(LISTS.filter(listed).map(name => [name, compareList(chat[name], usable ? before.lists[name] : [], usable && confined)]));
    const next = { ...record, ids, texts: itemTexts.texts, fields,
      lists: Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list.texts])) };
    if (!usable) return { chat, record: next };
    /** @type {any} */
    const delta = { id: chat.id, items: itemTexts.changed.map(index => items[index]), itemsFrom: before.ids.length, itemCount: items.length };
    for (const [name, text] of fields) if (before.fields.get(name) !== text) delta[name] = chat[name];
    const removed = [...before.fields.keys(), ...Object.keys(before.lists)].filter(name => !fields.has(name) && !lists[name]);
    if (removed.length) delta.removedFields = removed;
    const changedLists = Object.entries(lists).filter(([name, list]) => list.changed.length || chat[name].length !== before.lists[name].length);
    if (changedLists.length) delta.listChanges = Object.fromEntries(changedLists.map(([name, list]) =>
      [name, { from: before.lists[name].length, length: chat[name].length, entries: list.changed.map(index => [index, chat[name][index]]) }]));
    return { chat: delta, record: next };
  }

  // What one receiver (the desktop window, or one browser connection) has been sent.
  // push(): the next state of its stream, numbered (stateSeq). Only the chats that changed go, and everything every
  // FULL_STATE_MS, which repairs a chat whose edit did not move its bot's revision. That was every 5 s for the window:
  // 64 MB and a 0.2 s freeze each time on the user's 16 bots (2026-11-10). At 60 s it cost a phone about 1 MB a minute
  // (2026-10-26).
  // reply(): a command's answer. The same trimming, but not recorded as sent, because a page may never apply a reply;
  // the chats it carried go whole on their next push. stateBase names the push it builds on (acceptState). A full state as every reply was 64 MB per bot switch or send.
  // Numbers start at the clock and are shared by every stream, so a reply from before a reconnect or a restart never
  // matches a later push.
  const FULL_STATE_MS = 10 * 60000;
  let lastSeq = Date.now();
  function stateStream() {
    let sent = new Map(), seq = 0, fullAt = Date.now();
    return {
      /** @param {any} state */
      push(state) {
        const full = Date.now() - fullAt >= FULL_STATE_MS;
        if (full) fullAt = Date.now();
        seq = ++lastSeq;
        return { ...trimFleet(state, sent, full), stateSeq: seq };
      },
      /** @param {any} state */
      // A reply compares every message: what it answers (an Undo, say) can touch any of them.
      reply(state) {
        const copy = new Map(sent), trimmed = trimFleet(state, copy, false, true);
        // A page that applies the reply no longer holds what the next push's chatDelta builds on (a send's reply adds its
        // message and pendingMessage, which the turn then clears), so a chat the reply carried goes whole on its next change.
        // ponytail: one whole send per command that changes a chat (4.8 MB on the largest, at human pace); to cut it,
        // resend only the messages and fields the reply carried.
        for (const [key, records] of copy) {
          const live = sent.get(key);
          let marked = null;
          for (const [chatId, record] of records) {
            const before = live?.get(chatId);
            if (before?.texts && before !== record) (marked ||= new Map(live)).set(chatId, { mark: before.mark });
          }
          if (marked) sent.set(key, marked);
        }
        return { ...trimmed, stateBase: seq };
      },
      // The receiver holds nothing (a page load, or it asked for everything): the next push carries every chat.
      reset() { sent = new Map(); },
      get started() { return sent.size > 0; },
    };
  }

  // The window side of stateStream. A push always applies. A reply is dropped (false) when a later push was applied
  // first, since it would put older chats over newer ones and that push carries everything the reply does, and when the
  // page holds nothing yet. A reply ahead of the page (a browser whose stream lags) applies: the pushes on their way
  // follow it. applied: { seq } of this page.
  /** @param {any} next @param {{seq?: number}} applied */
  function acceptState(next, applied) {
    if (next?.stateBase !== undefined) return applied.seq !== undefined && next.stateBase >= applied.seq;
    if (next?.stateSeq !== undefined) applied.seq = next.stateSeq;
    return true;
  }

  // The window side: a context marked sessionsKept reuses the chats it already holds, and one with sessionIds fills the
  // chats it was not sent from them. A chat sent with itemsFrom carries only its changed messages, merged by message id
  // into the copy held (chatDelta, mergeChat). Null means a copy is missing or does not match (after a reload, say), so the caller
  // asks for a full state, or drops a reply.
  /** @param {any} next @param {any} previous */
  function keepSessions(next, previous) {
    if (!next?.agentStates) return next;
    if (next.jobBudgetsDelta) {
      if (!previous?.jobBudgets) return null;
      const budgets = { ...previous.jobBudgets, ...next.jobBudgets };
      for (const id of next.jobBudgetsRemoved || []) delete budgets[id];
      next.jobBudgets = budgets; delete next.jobBudgetsDelta; delete next.jobBudgetsRemoved;
    }
    for (const group of ['agentStates', 'executionStates']) {
      for (const [id, context] of Object.entries(next[group] || {})) {
        const kept = previous?.[group]?.[id]?.sessions;
        if (context.sessionsKept || context.sessionIds) {
          if (!kept) return null;
          if (context.sessionsKept) context.sessions = kept;
          else {
            const chats = new Map([...kept, ...context.sessions].map(chat => [chat.id, chat]));
            context.sessions = context.sessionIds.map((/** @type {string} */ chatId) => chats.get(chatId));
            if (context.sessions.some((/** @type {any} */ chat) => !chat)) return null;
          }
          delete context.sessionsKept;
          delete context.sessionIds;
        }
        if (!context.sessions?.some((/** @type {any} */ chat) => chat.itemsFrom !== undefined)) continue;
        const held = new Map((kept || []).map((/** @type {any} */ chat) => [chat.id, chat]));
        for (const [index, chat] of context.sessions.entries()) {
          if (chat.itemsFrom === undefined) continue;
          const merged = mergeChat(held.get(chat.id), chat);
          if (!merged) return null;
          context.sessions[index] = merged;
        }
      }
    }
    return next;
  }

  // A chatDelta onto the copy this window holds; null when that copy does not match what the delta was built on.
  /** @param {any} old @param {any} delta */
  function mergeChat(old, delta) {
    if (!old?.items || old.items.length !== delta.itemsFrom) return null;
    const at = new Map(old.items.map((/** @type {any} */ item, /** @type {number} */ position) => [item.id, position]));
    const items = old.items.slice();
    for (const item of delta.items) {
      const position = at.get(item.id);
      if (position === undefined) items.push(item);
      else items[position] = item;
    }
    if (items.length !== delta.itemCount) return null;
    const { itemsFrom, itemCount, removedFields, listChanges, items: sentItems, ...fields } = delta;
    const chat = { ...old, ...fields, items };
    for (const name of removedFields || []) delete chat[name];
    for (const [name, change] of Object.entries(listChanges || {})) {
      if (!Array.isArray(old[name]) || old[name].length !== change.from) return null;
      const list = old[name].slice(0, change.length);
      for (const [position, value] of change.entries) list[position] = value;
      if (list.length !== change.length) return null;
      chat[name] = list;
    }
    return chat;
  }

  return { INHERITED, AUTO_EFFORT, autoEffortMode, parseAutoEffort, BOT_SETTINGS, ROLE_STEPS, autoStep, isSubBot, inheritedSource, backgroundView, trimFleet, keepSessions, stateStream, acceptState, FULL_STATE_MS };
})();
if (typeof module !== 'undefined') module.exports = HarnessAgentState;

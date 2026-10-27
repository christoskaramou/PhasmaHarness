/** Shared by the runner and renderer so ownership and inheritance cannot diverge. */
var HarnessAgentState = (() => {
  /** @typedef {'read-only'|'workspace-write'|'danger-full-access'} Access */
  /** @typedef {{id:string, name?:string, createdBy?:string, temporaryBatch?:string, workspace?:string, access?:Access, mode?:string, inheritWorkspace?:boolean, inheritAccess?:boolean, inheritMode?:boolean}} Profile */
  /** @typedef {{id:string, delegation?:{owner?:string, source?:string, delivered?:boolean}}} Chat */
  /** @typedef {{conversationId?:string, sessions:Chat[]}} Context */
  /** @typedef {{agents?:Profile[], agentStates?:Record<string, Context>, executionStates?:Record<string, Context>}} Fleet */
  /** @type {{workspace:'inheritWorkspace', access:'inheritAccess', mode:'inheritMode'}} */
  const INHERITED = { workspace: 'inheritWorkspace', access: 'inheritAccess', mode: 'inheritMode' };

  /** @param {Profile|null|undefined} profile */
  function isSubBot(profile) {
    return !!profile?.createdBy && profile.createdBy !== 'main' && !profile.temporaryBatch;
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

  // The desktop window gets a bot's chats only when they changed since it last got them, and everything when full is set;
  // the Main Bot's chats are not repeated at the top level. A chat changed when its revision moved (the bot's
  // sharedRevision, or its own chatRevisions entry for a change confined to it) or its message count or status changed,
  // which also catches edits other bots' code makes. When only some chats changed, just those are sent, with sessionIds
  // giving the full order. sent: context key -> chat id -> mark.
  /** @param {any} state @param {Map<string, Map<string, string>>} sent @param {boolean} full */
  function trimFleet(state, sent, full) {
    if (!state?.agentStates) return state;
    const { sessions, ...trimmed } = state;
    for (const group of ['agentStates', 'executionStates']) {
      if (!state[group]) continue;
      trimmed[group] = {};
      for (const [id, context] of Object.entries(state[group])) {
        const key = group + ':' + id, chats = context.sessions || [];
        const shared = context.sharedRevision ?? context.stateRevision;
        const marks = new Map(chats.map((/** @type {any} */ chat) =>
          [chat.id, `${chat.items?.length ?? 0}:${chat.status}:${Math.max(shared, context.chatRevisions?.[chat.id] || 0)}`]));
        const previous = sent.get(key);
        sent.set(key, marks);
        const changed = full || !previous || previous.size !== marks.size ? chats
          : chats.filter((/** @type {any} */ chat) => previous.get(chat.id) !== marks.get(chat.id));
        const { sessions: all, ...light } = context;
        if (previous && !full && !changed.length) trimmed[group][id] = { ...light, sessionsKept: true };
        else if (changed.length === chats.length) trimmed[group][id] = context;
        else trimmed[group][id] = { ...light, sessions: changed, sessionIds: chats.map((/** @type {any} */ chat) => chat.id) };
      }
    }
    return trimmed;
  }

  // The window side: a context marked sessionsKept reuses the chats it already holds, and one with sessionIds fills the
  // chats it was not sent from them. Null means one is missing (after a reload, say), so the caller asks for a full state.
  /** @param {any} next @param {any} previous */
  function keepSessions(next, previous) {
    if (!next?.agentStates) return next;
    for (const group of ['agentStates', 'executionStates']) {
      for (const [id, context] of Object.entries(next[group] || {})) {
        if (!context.sessionsKept && !context.sessionIds) continue;
        const kept = previous?.[group]?.[id]?.sessions;
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
    }
    return next;
  }

  return { INHERITED, isSubBot, inheritedSource, backgroundView, trimFleet, keepSessions };
})();
if (typeof module !== 'undefined') module.exports = HarnessAgentState;

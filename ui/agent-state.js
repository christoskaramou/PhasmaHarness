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

  return { INHERITED, isSubBot, inheritedSource, backgroundView };
})();
if (typeof module !== 'undefined') module.exports = HarnessAgentState;

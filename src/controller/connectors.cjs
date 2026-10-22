const { randomUUID } = require('node:crypto');

module.exports = {
  async connectorTool(session, tool, args, signal) {
    if (!this.connectors) throw new Error('Shared connectors are unavailable on this runner.');
    const turn = this.activeTurns.get(session.id), submission = session.submission, access = session.access;
    const taskId = session.activeTaskId, task = session.tasks?.find(task => task.id === taskId), taskAccess = task?.access;
    const cancelledResult = session.agentReplyCancelledActive;
    const active = () => !!turn && this.activeTurns.get(session.id) === turn && session.submission === submission && session.access === access && session.activeTaskId === taskId && task?.access === taskAccess && session.agentReplyCancelledActive === cancelledResult && this.busy === session.id && !this.stopping.has(session.id) && this.assignmentCurrent(session) && !signal?.aborted && !this.cliAbort?.signal.aborted;
    if (!active()) throw new Error('Connector call rejected: the task is no longer active.');
    if (tool === 'connector_tools') {
      const result = await this.connectors.discover(args);
      if (!active()) throw new Error('Connector search stopped.');
      return result;
    }
    if (cancelledResult) throw new Error('A cancelled result cannot call external tools. Wait for a new user request.');
    if (!args || Object.keys(args).some(key => !['id', 'arguments'].includes(key)) || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || Buffer.byteLength(JSON.stringify(args.arguments)) > 65536) throw new Error('Invalid connector call.');
    await this.connectors.reload();
    if (!active()) throw new Error('Connector call stopped.');
    const { record, name } = this.connectors.target(args.id);
    if (!record.enabled) throw new Error('Connector is disabled.');
    // Filesystem Full access alone never grants remote access: the user must also opt this connector in.
    if (record.confirmCalls || access !== 'danger-full-access' || (taskAccess && taskAccess !== 'danger-full-access')) {
      const id = 'connector-' + randomUUID();
      const approved = await new Promise(resolve => {
        const finish = accepted => { signal?.removeEventListener('abort', stopped); this.helperApprovals.delete(id); this.requests.delete(id); this.changed(); resolve(accepted); };
        const stopped = () => finish(false);
        this.helperApprovals.set(id, finish);
        this.requests.set(id, { id, method: 'router/tool/requestApproval', taskId: session.activeTaskId,
          params: { threadId: session.threadId, reason: `Allow ${record.name} / ${name} once?`, command: JSON.stringify(args.arguments, null, 2) } });
        signal?.addEventListener('abort', stopped, { once: true }); this.changed();
      });
      if (!approved) throw new Error('Connector call declined or stopped.');
    }
    if (!active() || this.connectors.record(record.id) !== record) throw new Error('Task or connector settings changed. Discover tools again.');
    const result = await this.connectors.call(record, name, args.arguments, session.id, session.workspace, signal, active);
    if (!active()) throw new Error('Connector call stopped. Its remote action may have completed; check before retrying.');
    return this.toolHelpers.pack(session, result, { server: record.name, tool: name, capturedAt: new Date().toISOString() }, this.data.settings.largeResponses);
  },
};

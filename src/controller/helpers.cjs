'use strict';
// Helper tools offered to workers: project_context and the bundled tool helpers.
// These are Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const { isCLI } = require('../providers/capabilities.cjs');
const { TOOL: CONTEXT_TOOL } = require('../workspace/context-search.cjs');
const { TOOLS: HELPER_TOOLS } = require('../tools/tool-helpers.cjs');

module.exports = {
  async findContext(id, query, mode) {
    if (this.busy) throw new Error('Wait for the current turn to finish before using the search panel.');
    if (!this.contextSearch) throw new Error('Context search is unavailable.');
    return this.contextSearch.search(id ? this.session(id).workspace : this.data.settings.workspace, query, mode);
  },

  async contextToolCall(message) {
    const p = message.params;
    const session = this.data.sessions.find(s => s.threadId === p?.threadId);
    if (!session?.contextTool || this.busy !== session.id || this.stopping.has(session.id) ||
      this.activeTurns.get(session.id) !== p.turnId || p.tool !== CONTEXT_TOOL.name || p.namespace ||
      !p.arguments || Object.keys(p.arguments).some(key => key !== 'query') || this.contextRequests.has(message.id)) {
      this.client.rejectRequest(message.id, 'Unsupported or inactive project-context call.'); return;
    }
    this.contextRequests.add(message.id);
    try {
      const result = await this.contextSearch.search(session.workspace, p.arguments.query, this.data.settings.contextRanking || 'local');
      const output = session.helperTools ? this.toolHelpers.pack(session, result, { tool: CONTEXT_TOOL.name, workspace: session.workspace }, this.data.settings.largeResponses) : result;
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: JSON.stringify(output) }], success: true });
    } catch {
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: 'Context search failed or was stopped. Continue ordinary read-only project search if the task is still active.' }], success: false });
    } finally { this.contextRequests.delete(message.id); }
  },

  async bridgeTool(sessionId, tool, args, signal) {
    const session = this.session(sessionId);
    if (this.busy !== session.id || this.stopping.has(session.id) || !isCLI(session.activeProvider)) {
      throw new Error('Helper MCP call rejected: no active Claude/Cursor turn for this session.');
    }
    if (signal?.aborted || this.cliAbort?.signal.aborted) throw new Error('Helper call stopped.');
    this.toolHelpers.jev = this.smartRouter.jev;
    if (tool === CONTEXT_TOOL.name) {
      if (!session.contextTool || !this.contextSearch) throw new Error('Project context is unavailable for this session.');
      if (!args || Object.keys(args).some(key => key !== 'query')) throw new Error('Invalid project-context arguments.');
      const result = await this.contextSearch.search(session.workspace, args.query, this.data.settings.contextRanking || 'local');
      return session.helperTools ? this.toolHelpers.pack(session, result, { tool: CONTEXT_TOOL.name, workspace: session.workspace }, this.data.settings.largeResponses) : result;
    }
    if (!session.helperTools || !HELPER_TOOLS.some(item => item.name === tool)) throw new Error('Unsupported or inactive tool-helper call.');
    if (tool === 'router_find_tools') {
      if (!args || Object.keys(args).some(key => key !== 'query')) throw new Error('Invalid discovery arguments.');
      if (!session.threadId) {
        return {
          source: 'unsupported', recommendation: null, candidates: [], catalogCount: 0,
          note: 'UNSUPPORTED on Claude/Cursor without a Codex thread: router_find_tools lists Codex-connected MCP servers. Use Claude/Cursor native tools, or continue in a Codex/Responses worker after connecting MCP servers there. project_context and router_read_output remain available through the bundled phasma_harness MCP.',
        };
      }
      const result = await this.toolHelpers.find(session.threadId, args.query, this.data.settings.toolSelection === 'jev');
      const decisions = session.toolDecisions ||= [];
      decisions.push({
        at: Date.now(), source: result.source, recommendation: result.recommendation, confidence: result.confidence,
        usage: result.usage, durationMs: result.durationMs, warning: result.warning
      });
      session.toolDecisions = decisions.slice(-20); this.changed();
      return this.toolHelpers.pack(session, result, { tool: 'router_find_tools' }, this.data.settings.largeResponses);
    }
    if (tool === 'router_read_output') return this.toolHelpers.read(session, args);
    if (tool === 'router_call_tool') {
      if (!args || Object.keys(args).some(key => !['id', 'arguments'].includes(key)) || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || JSON.stringify(args.arguments).length > 65536) {
        throw new Error('Invalid MCP arguments.');
      }
      if (!session.threadId) {
        throw new Error('UNSUPPORTED on Claude/Cursor without a Codex thread: router_call_tool executes Codex-connected MCP tools only. Use native Claude/Cursor tools, or a Codex/Responses worker for the MCP gateway.');
      }
      const target = await this.toolHelpers.tool(session.threadId, args.id);
      if (this.busy !== session.id || this.stopping.has(session.id)) throw new Error('Task stopped.');
      if (session.access !== 'danger-full-access') {
        const id = `router-${randomUUID()}`;
        const approved = await new Promise(resolve => {
          this.helperApprovals.set(id, resolve);
          this.requests.set(id, {
            id, method: 'router/tool/requestApproval', params: {
              threadId: session.threadId,
              reason: `Allow connected tool ${target.server}/${target.name} once? Jev selection does not grant permission.`,
              command: JSON.stringify({ server: target.server, tool: target.name, arguments: args.arguments }, null, 2)
            }
          });
          this.changed();
        });
        if (!approved) throw new Error('Connected tool call declined or stopped.');
      }
      if (this.busy !== session.id || this.stopping.has(session.id)) throw new Error('Task stopped.');
      const raw = await this.client.call('mcpServer/tool/call', { threadId: session.threadId, server: target.server, tool: target.name, arguments: args.arguments });
      return this.toolHelpers.pack(session, raw, { server: target.server, tool: target.name, capturedAt: new Date().toISOString() }, this.data.settings.largeResponses);
    }
    throw new Error(`Unknown helper tool: ${tool}`);
  },

  cancelHelpers(prefix = '') {
    this.toolHelpers.cancel();
    for (const [id, resolve] of this.helperApprovals) if (id.startsWith(prefix)) { resolve(false); this.requests.delete(id); this.helperApprovals.delete(id); this.approvalKeys.delete(id); }
  },

  async helperToolCall(message) {
    const p = message.params, session = this.data.sessions.find(s => s.threadId === p?.threadId);
    const active = () => session?.helperTools && this.busy === session.id && !this.stopping.has(session.id) && this.activeTurns.get(session.id) === p.turnId;
    if (!active() || p.namespace || !HELPER_TOOLS.some(tool => tool.name === p.tool) || this.helperRequests.has(message.id) ||
      !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
      this.client.rejectRequest(message.id, 'Unsupported or inactive tool-helper call.'); return;
    }
    this.helperRequests.add(message.id);
    try {
      const a = p.arguments;
      let result;
      this.toolHelpers.jev = this.smartRouter.jev;
      if (p.tool === 'router_find_tools') {
        if (Object.keys(a).some(key => key !== 'query')) throw new Error('Invalid discovery arguments.');
        result = await this.toolHelpers.find(session.threadId, a.query, this.data.settings.toolSelection === 'jev');
        const decisions = session.toolDecisions ||= [];
        decisions.push({
          at: Date.now(), source: result.source, recommendation: result.recommendation, confidence: result.confidence,
          usage: result.usage, durationMs: result.durationMs, warning: result.warning
        });
        session.toolDecisions = decisions.slice(-20); this.changed();
        result = this.toolHelpers.pack(session, result, { tool: 'router_find_tools' }, this.data.settings.largeResponses);
      } else if (p.tool === 'router_read_output') result = this.toolHelpers.read(session, a);
      else {
        if (Object.keys(a).some(key => !['id', 'arguments'].includes(key)) || !a.arguments || typeof a.arguments !== 'object' || Array.isArray(a.arguments) || JSON.stringify(a.arguments).length > 65536) throw new Error('Invalid MCP arguments.');
        const tool = await this.toolHelpers.tool(session.threadId, a.id);
        if (!active()) throw new Error('Task stopped.');
        // Direct app-server calls must not bypass the user's Ask/workspace permissions.
        if (session.access !== 'danger-full-access') {
          const id = `router-${randomUUID()}`;
          const approved = await new Promise(resolve => {
            this.helperApprovals.set(id, resolve);
            this.requests.set(id, {
              id, method: 'router/tool/requestApproval', params: {
                threadId: session.threadId,
                reason: `Allow connected tool ${tool.server}/${tool.name} once? Jev selection does not grant permission.`,
                command: JSON.stringify({ server: tool.server, tool: tool.name, arguments: a.arguments }, null, 2)
              }
            });
            this.changed();
          });
          if (!approved) throw new Error('Connected tool call declined or stopped.');
        }
        if (!active()) throw new Error('Task stopped.');
        const raw = await this.client.call('mcpServer/tool/call', { threadId: session.threadId, server: tool.server, tool: tool.name, arguments: a.arguments });
        result = this.toolHelpers.pack(session, raw, { server: tool.server, tool: tool.name, capturedAt: new Date().toISOString() }, this.data.settings.largeResponses);
      }
      if (!active()) throw new Error('Task stopped; late tool output ignored.');
      // Keep native image/audio blocks intact instead of converting their base64 data to model text.
      let contentItems;
      if (Array.isArray(result.content) && result.content.some(item => item.type === 'image' || item.type === 'audio')) {
        contentItems = result.content.map(item => item.type === 'image' ? { type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }
          : item.type === 'audio' ? { type: 'inputAudio', audioUrl: `data:${item.mimeType};base64,${item.data}` }
            : { type: 'inputText', text: item.type === 'text' ? item.text : JSON.stringify(item) });
        if (result.structuredContent !== undefined) contentItems.push({ type: 'inputText', text: JSON.stringify(result.structuredContent) });
      } else contentItems = [{ type: 'inputText', text: JSON.stringify(result) }];
      this.client.respond(message.id, { contentItems, success: result.isError !== true });
    } catch (error) {
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: `Tool helper failed: ${error.message}. No automatic retry. Use native tools only if the task and permissions still allow it.` }], success: false });
    } finally { this.helperRequests.delete(message.id); }
  },
};

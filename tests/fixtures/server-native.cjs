const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function install(Controller) {
  Controller.prototype.warmRouter = () => {};
  Controller.prototype.isCoordinator = () => false;
  Controller.prototype.initialize = async function () {
    this.account = { type: 'chatgpt', planType: 'fixture' };
    this.models = [{ model: 'gpt-5.6-terra', displayName: 'Fixture worker', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
    const models = this.models;
    this.codex = { installed: true, connected: true, signedIn: true };
    this.data.settings.museEnabled = false;
    const muse = this.nativeCLIs.get('native:muse');
    muse.status = { installed: true, loggedIn: true };
    muse.refresh = async () => muse.status;
    muse.models = [{ id: 'native:muse:muse-fixture', provider: 'native:muse', model: 'muse-fixture', label: 'Fixture Muse',
      rank: 35, worker: true, router: false, efforts: [], effort: null }];
    muse.login = () => { throw new Error('Browser must not start native sign-in.'); };
    const deepseek = this.nativeCLIs.get('native:deepseek');
    deepseek.status = { installed: true, loggedIn: false }; deepseek.refresh = async () => deepseek.status;
    deepseek.login = () => { throw new Error('Browser must not start native sign-in.'); };
    this.data.settings.mode = 'terra-light'; this.data.settings.routerPreset = 'codex:gpt-5.6-terra:low';
    this.data.settings.routing = 'smart'; this.data.settings.jevEnabled = false;
    this.client.start = async () => {};
    this.client.call = async (method, params) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'fixture' } };
      if (method === 'model/list') return { data: models };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: randomUUID() } };
      if (method === 'turn/interrupt') queueMicrotask(() => this.notification({ method: 'turn/completed',
        params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }));
      return {};
    };
    await this.bridge.start(); this.connection = 'ready';
    const workspace = this.data.settings.workspace;
    fs.mkdirSync(path.join(workspace, 'export', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'export', 'game.txt'), 'portable fixture');
    fs.writeFileSync(path.join(workspace, 'export', 'assets', 'data.txt'), 'required assets');
    const session = this.agents.conversation(this) || this.agents.conversation(this, true, workspace, 'read-only');
    if (!session.items.some(item => item.id === 'artifact-fixture-export')) {
      const artifact = { ...await require('../../src/artifacts.cjs').inspect(workspace, 'export'), id: 'export', scopeId: 'fixture', version: 1 };
      session.items.push({ id: 'artifact-fixture-export', type: 'agentArtifact', localOnly: true, artifact, createdAt: Date.now() });
    }
    this.save(); this.changed();
  };
}

module.exports = { install };

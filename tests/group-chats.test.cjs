'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../src/group-chats.cjs');

function fixture() {
  const profiles = [{ id: 'one', name: 'Code' }, { id: 'two', name: 'Code Review' }];
  const agents = {
    profile: id => profiles.find(profile => profile.id === id),
    hubName: () => 'Hub',
    pendingJobs: () => [],
    primary: { data: { settings: { workspace: '/project', access: 'read-only' }, sessions: [] },
      workspace: value => value, save() {}, changed() {},
      session(id) { const session = this.data.sessions.find(item => item.id === id); if (!session) throw new Error('Unknown group'); return session; } },
  };
  return { agents, profiles };
}

test('groups persist only explicit membership, retain default permissions and roll back failed saves', () => {
  const { agents } = fixture();
  const session = groups.save(agents, { name: ' Game team ', members: ['one', 'two'] });
  assert.equal(session.title, 'Game team');
  assert.equal(session.access, 'read-only');
  assert.deepEqual(session.group, { members: ['one', 'two'], owner: 'main' });
  assert.deepEqual(groups.members(agents, session).map(member => member.name), ['Hub', 'Code', 'Code Review']);
  agents.primary.save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => groups.save(agents, { id: session.id, name: 'Changed', members: ['two'] }), /Disk unavailable/);
  assert.equal(session.title, 'Game team');
  assert.deepEqual(session.group.members, ['one', 'two']);
  assert.throws(() => groups.save(agents, { name: 'New', members: ['one'] }), /Disk unavailable/);
  assert.equal(agents.primary.data.sessions.length, 1);
});

test('leading group mentions resolve one current member, including spaces, without matching quoted text or email', () => {
  const { agents, profiles } = fixture();
  const session = groups.save(agents, { name: 'Team', members: ['one', 'two'] });
  assert.equal(groups.recipient(agents, session, '@Code Review, check this').id, 'two');
  assert.equal(groups.recipient(agents, session, ' \n@code check this').id, 'one');
  assert.equal(groups.recipient(agents, session, '@Hub explain').id, 'main');
  assert.equal(groups.recipient(agents, session, 'Explain this email user@Code'), null);
  assert.equal(groups.recipient(agents, session, 'Quote: @Code check this'), null);
  assert.throws(() => groups.recipient(agents, session, '@Codes check'), /current group member/);
  assert.throws(() => groups.recipient(agents, session, '@Unknown check'), /current group member/);
  assert.throws(() => groups.recipient(agents, session, '@Code @Hub check'), /one bot per message/);
  profiles[1].name = 'CODE';
  assert.throws(() => groups.recipient(agents, session, '@code check'), /more than one/);
  assert.throws(() => groups.save(agents, { id: session.id, name: 'Team', members: ['one', 'two'] }), /distinct names/);
  profiles.pop();
  assert.throws(() => groups.recipient(agents, session, '@CodeReview check'), /current group member/);
});

test('group membership rejects unknown, repeated, empty, oversized and archived edits', () => {
  const { agents } = fixture();
  for (const members of [[], ['missing'], ['main'], ['one', 'one'], Array(11).fill('one')]) {
    assert.throws(() => groups.save(agents, { name: 'Team', members }), /choose one to ten/);
  }
  const session = groups.save(agents, { name: 'Team', members: ['one'] });
  session.archived = true;
  assert.throws(() => groups.save(agents, { id: session.id, name: 'Changed', members: ['one'] }), /no longer available/);
});

test('a failed group message save cannot dispatch inference or replace the preceding request', () => {
  const { agents } = fixture();
  const session = groups.save(agents, { name: 'Team', members: ['one'] });
  const previous = session.hubRequest = { id: 'previous', text: 'Earlier request' };
  let dispatched = false;
  agents.delegate = () => { dispatched = true; };
  const controller = { agents, save() { throw new Error('Disk unavailable'); }, changed() {} };
  assert.throws(() => groups.dispatch(controller, session, { id: 'one', name: 'Code' },
    { text: '@Code inspect', images: [], turnId: 'turn' }), /Disk unavailable/);
  assert.equal(dispatched, false);
  assert.equal(session.items.length, 0);
  assert.equal(session.hubRequest, previous);
});

// Back/forward through opened chats: the sidebar buttons, Alt+Left/Right, the mouse's side buttons, a new chat dropping
// the forward entries and deleted bots being skipped.
const assert = require('node:assert/strict');

module.exports = async (window, botId) => {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 50));
    const back = document.querySelector('#nav-back'), forward = document.querySelector('#nav-forward');
    const here = () => [selectedAgent, back.disabled, forward.disabled];
    const steps = [];
    await selectAgent('main');
    navBack.length = 0; navForward.length = 0; renderNav();
    steps.push(here());
    await selectAgent(${JSON.stringify(botId)}); steps.push(here());
    await selectAgent(${JSON.stringify(botId)}); steps.push(['same chat not recorded', navBack.length]);
    back.click(); await tick(); steps.push(here());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
    await tick(); steps.push(here());
    dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })); await tick(); steps.push(here());
    dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true })); await tick(); steps.push(here());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }));
    await tick(); steps.push(here());
    await selectAgent(${JSON.stringify(botId)}); steps.push(here());
    navBack.push({ id: 'deleted-bot', groupId: null });
    back.click(); await tick(); steps.push(here());
    navBack.length = 0; navForward.length = 0; navForward.push({ id: 'deleted-bot', groupId: null }); renderNav(); steps.push(['only deleted ahead', forward.disabled]);
    navBack.length = 0; navForward.length = 0; renderNav();
    const box = back.getBoundingClientRect();
    return { steps, region: getComputedStyle(back).webkitAppRegion, visible: box.width > 0 && box.height > 0 };
  })()`);
  assert.deepEqual(result.steps, [
    ['main', true, true],
    [botId, false, true],
    ['same chat not recorded', 1],
    ['main', true, false],
    [botId, false, true],
    ['main', true, false],
    [botId, false, true],
    ['main', true, false],
    [botId, false, true],
    ['main', true, false],
    ['only deleted ahead', true]
  ]);
  assert.equal(result.region, 'no-drag', 'nav buttons stay clickable in the drag strip');
  assert.equal(result.visible, true, 'nav buttons are shown');
  console.log('Back/forward buttons, Alt+arrows, mouse side buttons, new chat dropping forward and deleted bots skipped passed');
};

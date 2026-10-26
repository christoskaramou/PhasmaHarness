'use strict';
// Stable identity colours shared by the roster, conversation and connectors.
var HarnessMosaic = (() => {
  function icon(key, main = false) {
    let hash = 0;
    for (const character of String(key || '')) hash = (hash * 31 + character.codePointAt(0)) | 0;
    const node = document.createElement('span');
    node.className = `mosaic-mark mosaic-${main ? 'main' : Math.abs(hash) % 5}`;
    node.setAttribute('aria-hidden', 'true');
    for (let tile = 0; tile < 4; tile++) node.append(document.createElement('i'));
    return node;
  }
  for (const node of document.querySelectorAll('[data-mosaic]')) node.prepend(icon(node.dataset.mosaic, true));
  const paths = {
    general: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    browser: 'M3 5h18v14H3ZM3 9h18M6 7h.01M9 7h.01',
    routing: 'M6 3v12M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M18 9a9 9 0 0 1-9 9',
    tools: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z',
    providers: 'm12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5',
    connectors: 'm10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    benchmarks: 'M5 19V9M12 19V4M19 19v-7',
    checks: 'M4 4h16v16H4ZM8 12l3 3 5-6',
    wiki: 'M5 3h9l5 5v13H5ZM14 3v6h5M9 13h6M9 17h4',
    about: 'M12 11v6M12 7v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  };
  for (const tab of document.querySelectorAll('.settings-tab')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '-2 0 28 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[tab.dataset.tab]); svg.append(path); tab.prepend(svg);
  }
  // The phone layout's query (phoneLayout in ui/app.js): narrow, or a phone on its side.
  const narrow = matchMedia('(max-width:720px), (max-height:500px)');
  const orientTabs = () => document.querySelector('.settings-tabs').setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
  narrow.addEventListener('change', orientTabs); orientTabs();
  return { icon };
})();

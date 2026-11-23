// Composer numbered lists: "<n>." + Space indents two spaces, Shift+Enter continues with the next number,
// Shift+Enter on an unused number removes it, and sending preserves the first item's leading indent.
const assert = require('node:assert/strict');

module.exports = async (window, sent) => {
  const result = await window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt');
    const saved = { value: prompt.value, readOnly: prompt.readOnly };
    prompt.readOnly = false;
    prompt.focus();

    const press = (key, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
      prompt.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const set = (value, start = value.length, end = start) => {
      prompt.value = value;
      prompt.setSelectionRange(start, end);
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // 1. "1." + Space -> "  1. "
    set('1.');
    const indentPrevented = press(' ');
    const afterIndent = { value: prompt.value, caret: prompt.selectionStart };

    // 2. Shift+Enter continues to "  2. " and expands the composer
    set(prompt.value + 'first');
    const nextPrevented = press('Enter', true);
    const afterNext = {
      value: prompt.value,
      caret: prompt.selectionStart,
      expanded: document.querySelector('#composer').classList.contains('composer-expanded')
    };

    // 3. Continue again to "  3. ", then Shift+Enter on empty "  3. " removes it
    set(prompt.value + 'second');
    press('Enter', true);
    const afterThird = prompt.value;
    const clearPrevented = press('Enter', true);
    const afterClear = { value: prompt.value, caret: prompt.selectionStart };

    // 4. Undo restores the removed empty item (execCommand preserves native undo)
    document.execCommand('undo');
    const afterUndo = prompt.value;

    // 5. Starting at "2." on a subsequent line
    set('Tasks:\\n2.');
    press(' ');
    const secondLineStart = prompt.value;
    set(prompt.value + 'step');
    press('Enter', true);
    const secondLineNext = prompt.value;

    // 6. Multi-digit rollover 9 -> 10 and pasted Unicode line separator U+2028 in item body
    set('  9. ninth');
    press('Enter', true);
    const rollover = prompt.value;
    set('  1. line\\u2028part');
    const unicodeSepPrevented = press('Enter', true);
    const unicodeSepNext = prompt.value;

    // 7. Guards: already indented, decimal, caret before prefix, leading newline at start=0, readOnly
    set('  1.');
    const alreadyIndentedPrevented = press(' ');
    set('1.5');
    const decimalPrevented = press(' ');
    set('  1. first', 0, 0);
    const beforePrefixPrevented = press('Enter', true);
    set('\\n  1. first', 0, 0);
    const leadingNewlinePrevented = press('Enter', true);
    prompt.readOnly = true;
    set('1.');
    const readOnlyPrevented = press(' ');

    prompt.readOnly = saved.readOnly;
    set(saved.value);
    return {
      indentPrevented, afterIndent,
      nextPrevented, afterNext,
      afterThird, clearPrevented, afterClear, afterUndo,
      secondLineStart, secondLineNext, rollover, unicodeSepPrevented, unicodeSepNext,
      alreadyIndentedPrevented, decimalPrevented, beforePrefixPrevented, leadingNewlinePrevented, readOnlyPrevented
    };
  })()`);

  assert.equal(result.indentPrevented, true);
  assert.deepEqual(result.afterIndent, { value: '  1. ', caret: 5 });
  assert.equal(result.nextPrevented, true);
  assert.deepEqual(result.afterNext, { value: '  1. first\n  2. ', caret: 16, expanded: true });
  assert.equal(result.afterThird, '  1. first\n  2. second\n  3. ');
  assert.equal(result.clearPrevented, true);
  assert.deepEqual(result.afterClear, { value: '  1. first\n  2. second\n', caret: 23 });
  assert.equal(result.afterUndo, '  1. first\n  2. second\n  3. ');
  assert.equal(result.secondLineStart, 'Tasks:\n  2. ');
  assert.equal(result.secondLineNext, 'Tasks:\n  2. step\n  3. ');
  assert.equal(result.rollover, '  9. ninth\n  10. ');
  assert.equal(result.unicodeSepPrevented, true);
  assert.equal(result.unicodeSepNext, '  1. line\u2028part\n  2. ');
  assert.equal(result.alreadyIndentedPrevented, false);
  assert.equal(result.decimalPrevented, false);
  assert.equal(result.beforePrefixPrevented, false);
  assert.equal(result.leadingNewlinePrevented, false);
  assert.equal(result.readOnlyPrevented, false);

  // 8. Submit path preserves leading list indent on item 1 while still trimming plain prose.
  const sentBefore = sent.length;
  const submitDraft = async text => {
    const before = sent.length;
    await window.webContents.executeJavaScript(`(async () => {
      const prompt = document.querySelector('#prompt');
      prompt.value = ${JSON.stringify(text)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
      for (let i = 0; i < 100 && submitting; i++) await new Promise(resolve => setTimeout(resolve, 20));
    })()`);
    for (let i = 0; i < 100 && sent.length === before; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, before + 1, 'submit sends one message');
    return sent[sent.length - 1].text;
  };
  assert.equal(await submitDraft('  1. first\n  2. second\n'), '  1. first\n  2. second');
  assert.equal(await submitDraft('  plain text  '), 'plain text');
  sent.splice(sentBefore);
  console.log('Composer numbered list (auto-indent, Shift+Enter increment, empty removal, undo, U+2028, submit indent) passed');
};

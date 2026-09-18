import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetVoiceRelocationForTest, relocateVoiceControl } from './chrome.js';

/**
 * The bug this file exists for: relocateVoiceControl observed document.body
 * with {childList, subtree} and its callback assigned label.textContent = 'MIC'
 * unconditionally. Assigning textContent replaces the text node even when the
 * string is unchanged, which is a childList mutation in the observed subtree,
 * so the observer re-triggered itself forever. Callbacks are microtasks, so the
 * page hard-locked: no rAF, no render, black globe.
 *
 * A real MutationObserver is not needed to catch that. A fake node that counts
 * textContent writes, plus a fake observer that re-delivers the mutations its
 * own callback causes, reproduces the loop exactly — and blows up as a stack
 * overflow rather than a hung process, so the test can assert on it.
 */

/** Minimal element with a write-counting textContent. */
function makeNode(name, { text = '' } = {}) {
  const node = {
    nodeName: name,
    id: '',
    parentElement: null,
    children: [],
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    writes: 0,
    _text: text,
    get textContent() { return this._text; },
    set textContent(value) {
      this.writes += 1;
      const changed = this._text !== value;
      this._text = value;
      // A textContent assignment always replaces the text node, whether or not
      // the string differs — that is the whole trap.
      node._onMutate?.({
        type: 'childList', target: node, changed, addedNodes: [], removedNodes: [],
      });
    },
    appendChild(child) {
      const previous = child.parentElement;
      if (previous) {
        previous.children = previous.children.filter((c) => c !== child);
      }
      child.parentElement = node;
      node.children.push(child);
      // A real observer reports the removal on the OLD parent and the addition
      // on the new one; the removal record is what re-arms placement.
      if (previous && previous !== node) {
        previous._onMutate?.({
          type: 'childList', target: previous, addedNodes: [], removedNodes: [child],
        });
      }
      node._onMutate?.({
        type: 'childList', target: node, addedNodes: [child], removedNodes: [],
      });
      return child;
    },
    querySelector(selector) {
      return node._query?.[selector] || null;
    },
  };
  return node;
}

/**
 * Installs a document/MutationObserver pair. `deliver` fans every recorded
 * mutation back to observers watching that target, which is what a real
 * microtask checkpoint does.
 */
function installDom({ withVoice = true } = {}) {
  const slot = makeNode('DIV');
  slot.id = 'ts-ai-slot';
  const nav = makeNode('NAV');
  nav.id = 'ts-bottom-nav';
  const body = makeNode('BODY');
  slot.parentElement = nav;
  nav.parentElement = body;

  const label = makeNode('SPAN', { text: 'ON/OFF' });
  const voice = makeNode('DIV');
  voice.id = 'gev-voice-control';
  voice._query = { '.gev-mic-label': label };
  const dock = makeNode('DIV');
  dock.id = 'command-dock';
  dock.parentElement = body;
  if (withVoice) dock.appendChild(voice);

  const button = makeNode('BUTTON');
  button.id = 'ts-ai-button';

  const byId = {
    'ts-ai-slot': slot,
    'ts-ai-button': button,
    'command-dock': dock,
    'gev-voice-control': withVoice ? voice : null,
  };

  const observers = [];
  let deliveries = 0;
  const OVERFLOW = 200;

  const deliver = (record) => {
    deliveries += 1;
    if (deliveries > OVERFLOW) throw new Error('RUNAWAY: mutation feedback loop');
    for (const observer of observers) {
      if (!observer.targets.has(record.target)) continue;
      observer.callback([record], observer);
    }
  };
  for (const node of [slot, nav, body, dock, voice, label]) {
    if (node) node._onMutate = deliver;
  }

  globalThis.document = {
    body,
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }

    observe(target) { this.targets.add(target); }

    disconnect() {
      this.targets.clear();
      const i = observers.indexOf(this);
      if (i >= 0) observers.splice(i, 1);
    }
  };

  return {
    slot, body, dock, voice, label, button, observers,
    get deliveries() { return deliveries; },
    addChild: (parent) => parent.appendChild(makeNode('DIV')),
    attachVoice: () => { byId['gev-voice-control'] = voice; dock.appendChild(voice); },
  };
}

function cleanup() {
  _resetVoiceRelocationForTest();
  delete globalThis.document;
  delete globalThis.MutationObserver;
}

test('the label is written once, not on every observer callback', () => {
  const dom = installDom();
  try {
    relocateVoiceControl();
    assert.equal(dom.label.textContent, 'MIC');
    assert.equal(dom.label.writes, 1, 'first placement writes the label exactly once');

    // Unrelated DOM churn must not rewrite a label that already reads MIC.
    for (let i = 0; i < 25; i += 1) dom.addChild(dom.body);
    assert.equal(dom.label.writes, 1, 'a settled label is never rewritten');
  } finally {
    cleanup();
  }
});

test('an already-correct label mutates nothing, so no feedback loop starts', () => {
  const dom = installDom();
  try {
    dom.label.textContent = 'MIC';
    const baseline = dom.label.writes;
    relocateVoiceControl();
    assert.equal(dom.label.writes, baseline, 'no redundant write when the text already matches');
  } finally {
    cleanup();
  }
});

test('the observer disconnects once the control is placed', () => {
  const dom = installDom();
  try {
    relocateVoiceControl();
    assert.equal(dom.voice.parentElement, dom.slot);
    // One removal watcher remains; no placement observer on body or the dock.
    assert.equal(dom.observers.length, 1, 'exactly one observer survives placement');
    assert.equal(dom.observers[0].targets.has(dom.body), false, 'body is no longer observed');
    assert.equal(dom.observers[0].targets.has(dom.slot), true, 'the slot is watched for removal');
  } finally {
    cleanup();
  }
});

test('nothing is observed with subtree, so deep text churn is unreachable', () => {
  const dom = installDom();
  try {
    relocateVoiceControl();
    // The label lives inside the voice control; no observer targets it.
    for (const observer of dom.observers) {
      assert.equal(observer.targets.has(dom.label), false);
      assert.equal(observer.targets.has(dom.voice), false);
    }
    const before = dom.deliveries;
    dom.label.textContent = 'SOMETHING ELSE';
    assert.equal(dom.deliveries, before + 1, 'the write is recorded but reaches no observer');
    assert.equal(dom.label.writes, 2);
  } finally {
    cleanup();
  }
});

test('a control that appears later is picked up without a retry timer', () => {
  const dom = installDom({ withVoice: false });
  try {
    relocateVoiceControl();
    assert.equal(dom.voice.parentElement, null, 'nothing to place yet');
    assert.ok(dom.observers.length >= 1, 'a placement observer is armed');

    dom.attachVoice();
    assert.equal(dom.voice.parentElement, dom.slot, 'placed on arrival, no 800ms timer needed');
    assert.equal(dom.label.textContent, 'MIC');
    assert.equal(dom.label.writes, 1);
  } finally {
    cleanup();
  }
});

test('removing the control re-arms placement', () => {
  const dom = installDom();
  try {
    relocateVoiceControl();
    assert.equal(dom.voice.parentElement, dom.slot);
    const settledWrites = dom.label.writes;

    // Something else steals the node back out of the slot.
    dom.dock.appendChild(dom.voice);
    assert.equal(dom.voice.parentElement, dom.slot, 're-placed after removal');
    assert.ok(dom.label.writes <= settledWrites + 1, 'recovery does not churn the label');
  } finally {
    cleanup();
  }
});

test('the fake observer would catch the original bug', () => {
  // Guard on the harness itself: if a callback rewrites textContent
  // unconditionally while observing that subtree, the fan-out must blow up.
  // A harness that cannot reproduce the loop cannot prove the fix.
  const dom = installDom();
  try {
    const label = dom.label;
    const observer = new globalThis.MutationObserver(() => {
      label.textContent = 'MIC'; // unconditional — the shipped bug
    });
    observer.observe(label);
    assert.throws(() => { label.textContent = 'MIC'; }, /RUNAWAY/);
    observer.disconnect();
  } finally {
    cleanup();
  }
});

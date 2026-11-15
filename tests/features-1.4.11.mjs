// Run: node --test tests/*.mjs (Node.js 24)
// 1.4.11 UI bugfix regressions: explicit close must not yield to host modal
// candidates; Escape/Tab only yield to genuinely visible modals (positive rect,
// not zero-size/legacy placeholders); CSS keeps checkbox box size and wand row
// native flex-start alignment.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;

const ATTR_RE = /^([A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?$/;

function attrMatches(element, expression) {
  const match = expression.match(ATTR_RE);
  if (!match) return false;
  const [, name, doubleValue, singleValue, bareValue] = match;
  const expected = doubleValue ?? singleValue ?? bareValue;
  if (!element.hasAttribute(name)) return false;
  return expected === undefined || element.getAttribute(name) === expected;
}

class ClassList {
  constructor(element) { this.element = element; }
  get values() { return this.element.className.split(/\s+/).filter(Boolean); }
  _write(values) { this.element.className = values.join(' '); }
  add(...names) { this._write([...new Set([...this.values, ...names])]); }
  remove(...names) { this._write(this.values.filter(value => !names.includes(value))); }
  contains(name) { return this.values.includes(name); }
}

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._id = '';
    this._className = '';
    this.hidden = false;
    this.textContent = '';
    this.__rect = { width: 100, height: 100 };
    this.__computed = null;
    this.style = {};
    this.classList = new ClassList(this);
  }

  get id() { return this._id; }
  set id(value) { this._id = String(value); }
  get className() { return this._className; }
  set className(value) { this._className = String(value); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(entry => entry !== handler));
  }

  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getBoundingClientRect() { return this.__rect; }
  getClientRects() { return this.__rect.width > 0 && this.__rect.height > 0 ? [this.__rect] : []; }
  get offsetParent() {
    return this.__rect.width > 0 && this.__rect.height > 0 ? this.parentNode : null;
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }

  matches(selector) {
    const list = String(selector).split(',').map(part => part.trim()).filter(Boolean);
    return list.some(part => this._matchesOne(part));
  }

  _matchesOne(selector) {
    let work = selector;
    const negations = [];
    const attributes = [];
    work = work.replace(/:not\(\[([^\]]+)\]\)/g, (_, expression) => {
      negations.push(expression);
      return '';
    });
    work = work.replace(/\[([^\]]+)\]/g, (_, expression) => {
      attributes.push(expression);
      return '';
    });
    const id = work.match(/#([A-Za-z0-9_-]+)/)?.[1];
    const classes = [...work.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(match => match[1]);
    const tag = work.replace(/#[A-Za-z0-9_-]+/g, '').replace(/\.([A-Za-z0-9_-]+)/g, '').trim();
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (id && this.id !== id) return false;
    if (classes.some(name => !this.classList.contains(name))) return false;
    if (negations.some(expression => attrMatches(this, expression))) return false;
    return attributes.every(expression => attrMatches(this, expression));
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  dispatchEvent(event) { return fire(this, event.type, event); }
}

class Document extends Element {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.body = this.appendChild(new Element('body', this));
    this.activeElement = this.body;
  }
  createElement(tag) { return new Element(tag, this); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

function fire(target, type, properties = {}) {
  const event = {
    type,
    target,
    currentTarget: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...properties,
  };
  const path = [];
  let node = target;
  while (node) { path.push(node); node = node.parentNode; }
  for (const current of path) {
    event.currentTarget = current;
    for (const handler of [...(current.listeners.get(type) || [])]) handler(event);
    if (event.propagationStopped) break;
  }
  return event;
}

globalThis.getComputedStyle = element => element.__computed || { display: 'block', visibility: 'visible' };

let currentDocument = null;

function makePanel() {
  const document = new Document();
  currentDocument = document;
  globalThis.document = document;

  const overlay = document.createElement('div');
  overlay.id = 'rl-main-panel';
  overlay.className = 'rl-main-panel-overlay';
  overlay.hidden = true;

  const frame = document.createElement('div');
  overlay.appendChild(frame);

  const close = document.createElement('button');
  close.id = 'rl-close-main-panel';
  close.type = 'button';
  frame.appendChild(close);

  const body = document.createElement('div');
  body.id = 'rl-main-panel-body';
  frame.appendChild(body);

  document.body.appendChild(overlay);
  return { document, overlay, close, body };
}

function addModal(document, { className = 'rl-modal', hidden = false, width = 320, height = 220, display = 'block' } = {}) {
  const modal = document.createElement('div');
  modal.className = className;
  modal.hidden = hidden;
  modal.__rect = { width, height };
  modal.__computed = { display, visibility: 'visible' };
  if (hidden) modal.setAttribute('hidden', '');
  document.body.appendChild(modal);
  return modal;
}

function addPlaceholder(document, options = {}) {
  const placeholder = document.createElement('div');
  placeholder.id = 'dialogue_popup';
  placeholder.__rect = { width: 0, height: 0 };
  placeholder.__computed = { display: options.display || 'block', visibility: options.visibility || 'visible' };
  placeholder.hidden = options.hidden === true;
  document.body.appendChild(placeholder);
  return placeholder;
}

const { setupMainPanel } = await import('../presentation/modules/main-panel-ui.js');

afterEach(() => {
  if (currentDocument) {
    currentDocument.listeners.clear();
    currentDocument = null;
  }
});

test('close button closes and invokes onClose despite another visible modal candidate', () => {
  const { document, overlay, close } = makePanel();
  addModal(document);
  let closed = 0;
  const panel = setupMainPanel({ onClose: () => { closed += 1; } });

  panel.open();
  assert.equal(panel.isOpen(), true);
  assert.equal(document.body.classList.contains('rl-main-panel-open'), true);

  const click = fire(close, 'click');
  assert.equal(click.defaultPrevented, false);
  assert.equal(panel.isOpen(), false, 'close X must hide the panel');
  assert.equal(overlay.hidden, true);
  assert.equal(closed, 1, 'close must invoke onClose immediately');
  assert.equal(document.body.classList.contains('rl-main-panel-open'), false);
});

test('backdrop click also closes explicitly while another modal is visible', () => {
  const { document, overlay } = makePanel();
  addModal(document);
  let closed = 0;
  const panel = setupMainPanel({ onClose: () => { closed += 1; } });
  panel.open();

  fire(overlay, 'click');
  assert.equal(panel.isOpen(), false);
  assert.equal(closed, 1);
});

test('Escape ignores zero-size and CSS-hidden legacy popup placeholders', () => {
  const { document } = makePanel();
  addPlaceholder(document);
  const cssHidden = addPlaceholder(document, { display: 'none' });
  cssHidden.__rect = { width: 500, height: 400 };
  let closed = 0;
  const panel = setupMainPanel({ onClose: () => { closed += 1; } });

  panel.open();
  const escape = fire(document, 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true, 'Escape should be consumed by the panel');
  assert.equal(panel.isOpen(), false, 'placeholder must not block Escape close');
  assert.equal(closed, 1);
});

test('Escape yields to a genuinely visible modal', () => {
  const { document } = makePanel();
  addPlaceholder(document);
  addModal(document, { width: 360, height: 240 });
  let closed = 0;
  const panel = setupMainPanel({ onClose: () => { closed += 1; } });

  panel.open();
  const escape = fire(document, 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, false, 'Escape must be left to the visible modal');
  assert.equal(panel.isOpen(), true, 'panel must remain open');
  assert.equal(closed, 0);
});

test('Tab trap closes the loop over placeholders but yields to a visible modal', () => {
  const { document, overlay, close } = makePanel();
  addPlaceholder(document);
  const second = document.createElement('button');
  second.id = 'rl-second-focus';
  overlay.appendChild(second);
  let closed = 0;
  const panel = setupMainPanel({ onClose: () => { closed += 1; } });
  panel.open();

  document.activeElement = second;
  const tab = fire(document, 'keydown', { key: 'Tab', shiftKey: false });
  assert.equal(tab.defaultPrevented, true, 'zero-size placeholder must not disable the trap');
  assert.equal(document.activeElement, close, 'Tab from last focusable wraps to first');
  assert.equal(closed, 0);

  addModal(document, { width: 360, height: 240 });
  document.activeElement = second;
  const yielded = fire(document, 'keydown', { key: 'Tab', shiftKey: false });
  assert.equal(yielded.defaultPrevented, false, 'Tab must yield to a genuinely visible modal');
  assert.equal(document.activeElement, second, 'focus must stay untouched');
  assert.equal(panel.isOpen(), true);
});

test('CSS keeps themed checkbox dimensions and native wand alignment', () => {
  const css = readFileSync(new URL('../presentation/styles/main.css', import.meta.url), 'utf8');
  const block = selector => {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `missing CSS rule ${selector}`);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };

  const wand = block('#rl-wand-button');
  assert.match(wand, /justify-content:\s*flex-start/);
  assert.doesNotMatch(wand, /justify-content:\s*center/);
  assert.doesNotMatch(wand, /min-(width|height):\s*38px/);

  const checkbox = block('.rl-main-panel-body input[type="checkbox"]');
  assert.doesNotMatch(checkbox, /width:\s*auto/);
  assert.match(checkbox, /width:\s*var\(--mainFontSize,\s*1rem\)/);
  assert.match(checkbox, /height:\s*var\(--mainFontSize,\s*1rem\)/);
  assert.match(checkbox, /min-width:\s*var\(--mainFontSize,\s*1rem\)/);
  assert.match(checkbox, /min-height:\s*var\(--mainFontSize,\s*1rem\)/);
  assert.match(checkbox, /flex:\s*0 0 auto/);
  assert.doesNotMatch(checkbox, /(?:background|background-color|border-color|color)\s*:/);
});

test('manifest and runtime advertise the same 1.4.13 version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal(manifest.version, '1.4.13');
  assert.match(index, /window\.ResponseLinter\.version = '1\.4\.13'/);
  assert.match(index, /1\.4\.13 streamlined index loaded/);
});

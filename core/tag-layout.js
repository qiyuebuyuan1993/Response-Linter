import {
  findHtmlCommentRanges,
  findProtectedRanges,
  isIndexProtected,
  mergeRanges,
} from './text-scan.js';

const MAX_EXAMPLE_LENGTH = 24_000;
const MAX_PAIRS = 80;
const MAX_DEPTH = 10;
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const HTML_TAG = /<(\/?)([\p{L}][\p{L}\p{N}_.:-]*)(?=[\s/>])([^"'<>]*(?:(?:"[^"]*"|'[^']*')[^"'<>]*)*)>/gu;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
const SAFE_ID = /^[\p{L}\p{N}_.:-]{1,80}$/u;

function tagId(attributes) {
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() !== 'id') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    return SAFE_ID.test(value) ? value : '';
  }
  return '';
}

function scanTags(source, ranges) {
  const tokens = [];
  for (const match of source.matchAll(HTML_TAG)) {
    const [text, slash, rawName, attributes] = match;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name) || isIndexProtected(ranges, match.index)) continue;
    if (slash ? attributes.trim() : /\/\s*$/.test(attributes)) continue;
    tokens.push({
      name,
      id: slash ? '' : tagId(attributes),
      closing: !!slash,
      start: match.index,
      end: match.index + text.length,
    });
  }
  return tokens;
}

function readTagTree(tokens, end) {
  const roots = [];
  const nodes = [];
  const orphans = [];
  const stack = [];
  const byName = new Map();
  const pop = () => {
    const node = stack.pop();
    byName.get(node.open.name).pop();
    return node;
  };
  for (const token of tokens) {
    const parent = stack.at(-1) ?? null;
    if (!token.closing) {
      const node = { open: token, close: null, children: [], parent, limit: end };
      (parent ? parent.children : roots).push(node);
      nodes.push(node);
      stack.push(node);
      if (!byName.has(token.name)) byName.set(token.name, []);
      byName.get(token.name).push(node);
      continue;
    }
    const target = byName.get(token.name)?.at(-1);
    if (!target) {
      orphans.push({ token, parent });
      continue;
    }
    while (stack.at(-1) !== target) pop().limit = token.start;
    pop().close = token;
  }
  return { roots, nodes, orphans, unpaired: orphans.length + nodes.filter(node => !node.close).length };
}

const openTag = ({ name, id }) => id ? '<' + name + ' id="' + id + '">' : '<' + name + '>';
const closeTag = ({ name }) => '</' + name + '>';
const keyOf = ({ name, id }) => name + '#' + id;

function makeRule(node, depth) {
  if (depth > MAX_DEPTH) throw new Error('示例嵌套超过 ' + MAX_DEPTH + ' 层，请缩短嵌套。');
  return {
    name: node.open.name,
    id: node.open.id,
    children: node.children.map(child => makeRule(child, depth + 1)),
  };
}

function printRule(rule, depth = 0, showTitles = false) {
  const indent = '  '.repeat(depth);
  const open = indent + openTag(rule);
  const close = closeTag(rule);
  return rule.children.length
    ? [open, ...rule.children.map(child => printRule(child, depth + 1, showTitles)), indent + close].join('\n')
    : open + (showTitles && rule.name === 'summary' ? '标题（可变）' : '') + close;
}

function checkSiblingOrder(rules) {
  const positions = new Map();
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    const key = keyOf(rule);
    const lastIndex = positions.get(key);
    if (lastIndex != null && (lastIndex !== index - 1 ||
        JSON.stringify(rules[lastIndex].children) !== JSON.stringify(rule.children))) {
      throw new Error('同一层的 ' + openTag(rule) + ' 无法按结构区分。请使用不同外层标签或不同 id。');
    }
    positions.set(key, index);
    checkSiblingOrder(rule.children);
  }
}

export function parseTagLayout(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return { ok: true, text: '', layout: null };
  if (typeof value !== 'string' || value.length > MAX_EXAMPLE_LENGTH) {
    return { ok: false, error: '标签排列示例最多 ' + MAX_EXAMPLE_LENGTH + ' 个字符。' };
  }
  const protectedRanges = findProtectedRanges(value);
  const comments = findHtmlCommentRanges(value, protectedRanges);
  const tokens = scanTags(value, mergeRanges([...protectedRanges, ...comments]));
  if (tokens.length > MAX_PAIRS * 2) return { ok: false, error: '标签排列示例最多 ' + MAX_PAIRS + ' 对标签。' };
  const tree = readTagTree(tokens, value.length);
  if (!tree.roots.length || tree.unpaired) {
    return { ok: false, error: '请填写完整的示例，第一组最外层标签包住正文，每个标签都要成对并正确嵌套。' };
  }
  try {
    const [body, ...outside] = tree.roots.map(node => makeRule(node, 1));
    body.id = '';
    if (tree.nodes.some(node => node !== tree.roots[0] && node.open.name === body.name)) {
      throw new Error('正文标签 ' + openTag(body) + ' 在示例里只能出现一组。');
    }
    const outsideKeys = new Set(outside.map(keyOf));
    if (body.children.some(rule => outsideKeys.has(keyOf(rule)))) {
      throw new Error('正文内外有无法区分的同名结构块。请使用不同外层标签或不同 id。');
    }
    checkSiblingOrder(body.children);
    checkSiblingOrder(outside);
    const sdc = direction => comments.some(range => !isIndexProtected(protectedRanges, range.start) &&
      new RegExp('^<!--\\s*SDC-' + direction + '\\b', 'i').test(value.slice(range.start, range.end)));
    return {
      ok: true,
      text: [body, ...outside].map(rule => printRule(rule)).join('\n'),
      layout: {
        body: { open: openTag(body), close: closeTag(body) },
        inside: body.children,
        outside,
        hasSdc: sdc('start') && sdc('end'),
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// The editor annotates saved layouts. A pasted or unfinished draft keeps
// its original text, and display comments do not activate a time mode.
export function formatTagLayoutForEditor(value, timeMode) {
  if (!value) return value;
  const parsed = parseTagLayout(value);
  if (!parsed.ok || !parsed.layout || parsed.text !== value) return value;
  const { body, inside, outside } = parsed.layout;
  const start = timeMode === 'sdc' ? '  <!-- 开始时间 SDC-start -->' :
    timeMode === 'custom' ? '  <!-- 开始时间（自定义标记） -->' : '';
  const end = timeMode === 'sdc' ? '  <!-- 结束时间 SDC-end -->' :
    timeMode === 'custom' ? '  <!-- 结束时间（自定义标记） -->' : '';
  const lines = [body.open, start, '  正文……'];
  if (inside.length) lines.push('  <!-- 正文内的组 -->', ...inside.map(rule => printRule(rule, 1, true)));
  lines.push(end, body.close);
  if (outside.length) lines.push('<!-- 正文外的组 -->', ...outside.map(rule => printRule(rule, 0, true)));
  const example = lines.filter(Boolean).join('\n');
  return example.length <= MAX_EXAMPLE_LENGTH ? example : value;
}

function matchRule(rules, token) {
  return rules.find(rule => rule.name === token.name && rule.id && rule.id === token.id) ??
    rules.find(rule => rule.name === token.name && !rule.id);
}

function inspect(source, layout, readAnchors) {
  const anchors = readAnchors(source);
  const ranges = mergeRanges([...anchors.ranges, ...anchors.exclude]);
  const tree = readTagTree(scanTags(source, ranges), source.length);
  const floor = Math.max(anchors.bodyOpen?.end ?? 0, anchors.timeStart?.end ?? 0);
  const rules = [...layout.inside, ...layout.outside];
  const inside = new Set(layout.inside);
  const roots = tree.roots.filter(node => node.open.start >= floor);
  const assign = (siblings, allowed, zone) => {
    for (const node of siblings) {
      node.rule = matchRule(allowed, node.open);
      if (!node.rule) continue;
      node.zone = zone ?? (inside.has(node.rule) ? 'inside' : 'outside');
      assign(node.children, node.rule.children, node.zone);
    }
  };
  assign(roots, rules);
  return { ...tree, roots, rules, floor, inside, anchors, ranges };
}

function startOfRecognizedChildren(siblings, token, rule, floor) {
  const capacity = new Map();
  for (const child of rule.children) capacity.set(keyOf(child), (capacity.get(keyOf(child)) ?? 0) + 1);
  let start = null;
  for (const node of siblings.slice().reverse()) {
    if (node.open.start < floor || (node.close?.end ?? node.limit) > token.start) continue;
    const match = matchRule(rule.children, node.open);
    if (!match) break;
    const key = keyOf(match);
    if (!capacity.get(key)) break;
    capacity.set(key, capacity.get(key) - 1);
    start = node.open.start;
  }
  return start;
}

function findMissingOpener(source, state, orphan) {
  const { token, parent } = orphan;
  if (token.start < state.floor || (parent && !parent.rule)) return null;
  const allowed = parent ? parent.rule.children : state.rules;
  const candidates = allowed.filter(rule => rule.name === token.name);
  const unique = [...new Map(candidates.map(rule => [keyOf(rule), rule])).values()];
  // A closing tag has no id. Two different configured identities cannot be
  // distinguished from it alone.
  if (unique.length !== 1) return null;
  const rule = unique[0];
  const siblings = parent ? parent.children : state.roots;
  const inside = state.inside.has(rule);
  const physicalFloor = parent ? parent.open.end : state.floor;
  const bodyEnd = state.anchors.bodyClose?.end ?? state.anchors.timeEnd?.end ?? 0;
  // A wrapped child provides a more precise anchor even when the close or the
  // group itself is currently on the wrong side of the body boundary.
  const childFloor = !parent && bodyEnd <= token.start ? Math.max(physicalFloor, bodyEnd) : physicalFloor;
  const childStart = startOfRecognizedChildren(siblings, token, rule, childFloor);
  if (childStart != null) return { position: childStart, rule, opening: true };

  const previous = siblings.filter(node => node.close?.end <= token.start).at(-1);
  let start = physicalFloor;
  if (parent) {
    start = previous?.close.end ?? start;
  } else if (inside) {
    // Without a preceding inside group or a nested child, the narrative
    // gives no indication of where this block starts.
    if (previous?.zone !== 'inside') return null;
    start = previous.close.end;
  } else {
    if (bodyEnd > token.start || (!bodyEnd && state.anchors.bodyOpen)) return null;
    start = Math.max(start, previous?.close.end ?? 0, bodyEnd);
  }
  if (previous?.open.name === token.name && !source.slice(start, token.start).trim()) return null;
  const gap = source.slice(start, token.start);
  return { position: start + (gap.match(/^\s*/)?.[0].length ?? 0), rule, opening: true };
}

function findMissingCloser(source, state, node) {
  let end = node.limit;
  let lastChildEnd = node.open.end;
  const childCounts = new Map();
  for (const child of node.children) {
    const key = child.rule && keyOf(child.rule);
    const count = key ? (childCounts.get(key) ?? 0) + 1 : 0;
    if (key) childCounts.set(key, count);
    const expectedChild = key && count <= node.rule.children.filter(rule => keyOf(rule) === key).length;
    if (!expectedChild) {
      // A missing close can make a following peer look like a child.
      // A complete wrapper is never split by this test.
      let scope = node.parent;
      while (scope && !matchRule(scope.rule.children, child.open)) scope = scope.parent;
      if (scope || matchRule(state.rules, child.open)) {
        end = Math.min(end, child.open.start);
        break;
      }
    }
    if (child.close) lastChildEnd = Math.max(lastChildEnd, child.close.end);
  }
  if (node.zone === 'inside') {
    for (const marker of [state.anchors.timeEnd, state.anchors.bodyClose]) {
      if (marker && marker.start >= lastChildEnd) end = Math.min(end, marker.start);
    }
  }
  if (node.rule.name === 'summary') {
    const title = source.slice(node.open.end, end);
    const textStart = title.search(/\S/);
    const lineEnd = textStart < 0 ? -1 : title.indexOf('\n', textStart);
    if (lineEnd >= 0 && lastChildEnd <= node.open.end + lineEnd) end = node.open.end + lineEnd;
  }
  if (end < lastChildEnd) return null;
  const text = source.slice(node.open.end, end).trimEnd();
  const position = node.rule.name === 'summary' ? node.open.end + text.length : end;
  return { position, rule: node.rule, opening: false };
}

function applyTagInsertion(source, { position, rule, opening }) {
  const token = opening ? openTag(rule) : closeTag(rule);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const before = source.slice(0, position);
  const after = source.slice(position);
  if (rule.name === 'summary') return before + token + after;
  return before + (before && !before.endsWith('\n') ? eol : '') + token +
    (after && !/^[\r\n]/.test(after) ? eol : '') + after;
}

function sortSection(source, nodes, rules, start, end) {
  const slots = nodes.filter(node => node.rule && node.close && rules.includes(node.rule));
  const ordered = slots.slice().sort((left, right) => rules.indexOf(left.rule) - rules.indexOf(right.rule));
  let result = '';
  let cursor = start;
  for (const [index, slot] of slots.entries()) {
    const node = ordered[index];
    result += source.slice(cursor, slot.open.start) + source.slice(node.open.start, node.open.end) +
      sortSection(source, node.children, node.rule.children, node.open.end, node.close.start) +
      source.slice(node.close.start, node.close.end);
    cursor = slot.close.end;
  }
  return result + source.slice(cursor, end);
}

function* missingTagInsertions(source, state) {
  for (const orphan of state.orphans) yield findMissingOpener(source, state, orphan);
  for (let index = state.nodes.length - 1; index >= 0; index--) {
    const node = state.nodes[index];
    if (node.rule && !node.close) yield findMissingCloser(source, state, node);
  }
}

export function repairLayoutBlocks(source, layout, { readAnchors, enabled, crossBoundary }) {
  let content = source;
  let state = inspect(content, layout, readAnchors);
  const repairs = new Set();
  const warnings = [];
  if (enabled) {
    // Re-read the source after each successful insertion. Each insertion must
    // pair an existing tag, so it cannot create cascading guesses.
    for (let count = 0; count < MAX_PAIRS && state.unpaired; count++) {
      let repaired = false;
      for (const insertion of missingTagInsertions(content, state)) {
        if (!insertion || state.ranges.some(range =>
          range.start < insertion.position && insertion.position < range.end)) continue;
        const candidate = applyTagInsertion(content, insertion);
        const next = inspect(candidate, layout, readAnchors);
        if (next.unpaired >= state.unpaired) continue;
        content = candidate;
        state = next;
        repairs.add(insertion.opening ? 'inserted-block-open' : 'inserted-block-close');
        repaired = true;
        break;
      }
      if (!repaired) break;
    }
    if (state.nodes.some(node => node.rule && !node.close) ||
        state.orphans.some(({ token, parent }) => token.start >= state.floor &&
          (parent ? parent.rule?.children : state.rules)?.some(rule => rule.name === token.name))) {
      warnings.push('有配置的标签只出现了一半，无法确定另一半的位置。请检查对应块的开始、结束标签或用不同 id 区分。');
    }
    const boundary = state.anchors.bodyClose;
    let ordered = content;
    if (crossBoundary && (state.anchors.bodyOpen || boundary)) {
      ordered = sortSection(content, state.roots, state.rules, 0, content.length);
    } else if (boundary) {
      const inside = state.roots.filter(node => node.close?.end <= boundary.start);
      const outside = state.roots.filter(node => node.open.start >= boundary.end);
      if (state.roots.some(node => node.rule && node.close && (node.zone === 'inside'
        ? node.close.end > boundary.start : node.open.start < boundary.end))) {
        warnings.push('有结构块跨过正文边界。开启“修复正文 / 时间边界”后可一起调整。');
      }
      ordered = sortSection(content, inside, layout.inside, 0, boundary.end) +
        sortSection(content, outside, layout.outside, boundary.end, content.length);
    } else if (!state.anchors.bodyOpen && !state.anchors.bodyClose) {
      ordered = sortSection(content, state.roots, layout.outside, 0, content.length);
    }
    if (ordered !== content) {
      content = ordered;
      state = inspect(content, layout, readAnchors);
      repairs.add('reordered-blocks');
    }
  }
  return { content, changed: content !== source, repairs: [...repairs], warnings, state };
}

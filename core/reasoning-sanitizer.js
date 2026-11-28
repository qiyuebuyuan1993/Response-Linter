// Pure cleanup of the reasoning tags selected in a reply profile.
import { findHtmlCommentRanges, findMatchesOutsideRanges, findProtectedRanges, removeRanges } from './text-scan.js';

export const DEFAULT_REASONING_BLOCK_TAGS = Object.freeze(['think', 'thinking']);
const TAG_NAME_RE = /^[\p{L}][\p{L}\p{N}_.:~-]{0,59}$/u;
const REASONING_TAG_RE = /<(\/?)([\p{L}][\p{L}\p{N}_.:~-]*)(?=[\s/>])([^"'<>]*(?:(?:"[^"]*"|'[^']*')[^"'<>]*)*)>/gu;
const CLEAR_ANCHOR_RE = /<content\b[^>]*>|<!--\s*SDC-start\b/gi;

export function normalizeReasoningTagName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim().replace(/^<\/?([^\s<>/]+)\s*>$/, '$1');
  return TAG_NAME_RE.test(name) ? name.toLowerCase() : '';
}

function uncertainWarning(tagName) {
  return `检测到未闭合的 <${tagName}>，后面没有可确认的正文或时间起点。已保留原文，请检查推理块边界。`;
}

function malformedWarning() {
  return '检测到交叉或错配的推理标签，无法安全配对；已保留该处原文，请手动检查推理块边界。';
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function analyzeTokens(text, blockTags, tagsOnly) {
  const ranges = findProtectedRanges(text);
  const comments = findHtmlCommentRanges(text, ranges);
  const tokens = [];
  const stripTags = [];
  const quotedTagRanges = [];
  for (const match of findMatchesOutsideRanges(text, REASONING_TAG_RE, [...ranges, ...comments])) {
    const [, closing, rawName, attributes] = match;
    const tag = rawName.toLowerCase();
    if (attributes.includes('<')) quotedTagRanges.push({ start: match.index, end: match.index + match[0].length });
    if ((!blockTags.has(tag) && !tagsOnly.has(tag)) || (closing && attributes.trim())) continue;
    const token = { start: match.index, end: match.index + match[0].length, type: closing ? 'close' : 'open', tag };
    if (tagsOnly.has(tag) || (!closing && /\/\s*$/.test(attributes))) stripTags.push(token);
    else tokens.push(token);
  }

  const pairs = [];
  const malformed = [];
  const looseClosings = [];
  const uncertainClosings = new Set();
  const stack = [];
  for (const token of tokens) {
    if (token.type === 'open') {
      stack.push(token);
      continue;
    }
    if (!stack.length) {
      if (!uncertainClosings.has(token.tag)) looseClosings.push(token);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top.tag === token.tag) {
      const open = stack.pop();
      pairs.push({ start: open.start, end: token.end, open, close: token });
      continue;
    }
    // 交叉配对（如 <think>…</thinking>）会让中间整段无法确定归属，保守保留。
    malformed.push({ start: stack[0].start, end: token.end });
    for (const opening of stack) uncertainClosings.add(opening.tag);
    uncertainClosings.add(token.tag);
    stack.length = 0;
  }

  // 正确嵌套时同时得到内层与外层 pair；只删除最外层，避免重复计数/二次拼接。
  const removablePairs = [];
  for (const pair of pairs.sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (malformed.some(range => overlaps(range, pair))) continue;
    if (removablePairs.some(outer => pair.start >= outer.start && pair.end <= outer.end)) continue;
    removablePairs.push(pair);
  }

  return {
    ranges,
    comments,
    quotedTagRanges,
    malformed,
    stripTags,
    looseClosings,
    unmatchedOpenings: [...stack],
    removablePairs,
  };
}

function findAnchors(text, { ranges, comments, quotedTagRanges }, anchorPatterns, useDefaultAnchors = true) {
  const patterns = Array.isArray(anchorPatterns) ? [...anchorPatterns] : [];
  if (useDefaultAnchors) patterns.unshift(CLEAR_ANCHOR_RE);
  const anchors = [];
  for (const pattern of patterns) {
    if (!(pattern instanceof RegExp)) continue;
    try {
      const matches = findMatchesOutsideRanges(text, pattern, ranges);
      anchors.push(...matches.filter(match =>
        !quotedTagRanges.some(range => range.start < match.index && match.index < range.end) &&
        !comments.some(range => range.start <= match.index && match.index < range.end &&
          (range.start !== match.index || text.slice(range.end - 3, range.end) !== '-->'))));
    } catch {
      // Generated patterns are trusted; malformed optional patterns are ignored.
    }
  }
  return anchors.sort((left, right) => left.index - right.index);
}

/**
 * @param {string} content
 * @param {{maxIterations?:number, anchorPatterns?:RegExp[], useDefaultAnchorPatterns?:boolean,
 *   tagRules?:{blocks:string[],tagsOnly:string[]}, bodyTag?:string}} options
 * @returns {{content:string, changed:boolean, removedBlocks:number, removedLeaks:number, warnings:string[]}}
 */
export function sanitizeLeakedReasoning(content, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const maxIterations = Number.isInteger(options.maxIterations) && options.maxIterations > 0
    ? Math.min(options.maxIterations, 100)
    : 30;
  let result = source;
  let changed = false;
  let removedBlocks = 0;
  let removedLeaks = 0;
  const warnings = [];
  const blockTags = new Set(options.tagRules?.blocks ?? DEFAULT_REASONING_BLOCK_TAGS);
  const tagsOnly = new Set(options.tagRules?.tagsOnly ?? []);
  blockTags.delete(options.bodyTag);
  tagsOnly.delete(options.bodyTag);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (!blockTags.size && !tagsOnly.size) break;
    const analysis = analyzeTokens(result, blockTags, tagsOnly);

    if (analysis.removablePairs.length) {
      removedBlocks += analysis.removablePairs.length;
      result = removeRanges(result, analysis.removablePairs, { trimLines: true });
      changed = true;
      continue;
    }
    if (analysis.stripTags.length) {
      result = removeRanges(result, analysis.stripTags);
      changed = true;
      continue;
    }
    const anchors = findAnchors(result, analysis, options.anchorPatterns,
      options.useDefaultAnchorPatterns !== false);
    if (analysis.looseClosings.length) {
      const anchorStart = anchors[0]?.index;
      const leadingClose = anchorStart === undefined ? null
        : analysis.looseClosings.filter(token => token.end <= anchorStart).at(-1);
      let prefixEnd = 0;
      // 第一个正文或时间起点前的落单闭合标签，可以界定开头残留的推理。
      if (leadingClose && !analysis.malformed.some(range => range.start < leadingClose.end)) {
        prefixEnd = result.slice(leadingClose.end, anchorStart).trim() ? leadingClose.end : anchorStart;
        removedLeaks++;
      }
      const remainingClosings = analysis.looseClosings
        .filter(token => token.start >= prefixEnd)
        .map(token => ({ start: token.start - prefixEnd, end: token.end - prefixEnd }));
      result = removeRanges(result.slice(prefixEnd), remainingClosings, { trimLines: true });
      changed = true;
      continue;
    }

    // 没有可安全配对的完整块时，才处理“未闭合但后面有明确正文锚点”的泄漏。
    let leak = null;
    for (const open of analysis.unmatchedOpenings) {
      const anchor = anchors.find(match => match.index >= open.end);
      if (!anchor) continue;
      const hasMalformedBeforeAnchor = analysis.malformed.some(range =>
        range.start >= open.end && range.end <= anchor.index);
      if (hasMalformedBeforeAnchor) continue;
      leak = { start: open.start, end: anchor.index };
      break;
    }
    if (leak) {
      removedLeaks++;
      result = removeRanges(result, [leak]);
      changed = true;
      continue;
    }

    // 到这里不能安全删除任何内容；警告只描述最终实际保留的文本。
    for (const range of analysis.malformed) {
      if (range.end > range.start) warnings.push(malformedWarning());
    }
    for (const open of analysis.unmatchedOpenings) {
      const hasAnchor = anchors.some(match => match.index >= open.end);
      if (!hasAnchor) warnings.push(uncertainWarning(open.tag));
    }
    break;
  }

  return {
    content: result,
    changed,
    removedBlocks,
    removedLeaks,
    warnings: [...new Set(warnings)],
  };
}

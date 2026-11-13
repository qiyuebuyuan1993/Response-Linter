// 纯推理块清理：只删除完整的 <think>/<thinking> 块，或“未闭合但后面有明确
// <content> / SDC-start 锚点”的泄漏推理。代码围栏、行内代码与 <code>/<pre> 一律不改。
import { findMatchesOutsideRanges, findProtectedRanges, removeRanges } from './text-scan.js';

const REASONING_TAG_RE = /<(\/?)(think|thinking)\s*>/gi;
const CLEAR_ANCHOR_RE = /<content\b[^>]*>|<!--\s*SDC-start\b/gi;

function uncertainWarning(tagName) {
  return `检测到未闭合的 <${tagName}>，其后没有明确的 <content> 或 SDC-start 锚点；为避免误删正文，已保留原文。请先确认推理内容边界后再手动处理。`;
}

function malformedWarning() {
  return '检测到交叉、错配或没有对应开始的推理标签，无法安全配对；已保留该处原文，请手动检查推理块边界。';
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function analyzeTokens(text) {
  const ranges = findProtectedRanges(text);
  const tokens = findMatchesOutsideRanges(text, REASONING_TAG_RE, ranges)
    .map(match => ({
      start: match.index,
      end: match.index + match[0].length,
      type: match[1] ? 'close' : 'open',
      tag: match[2].toLowerCase(),
    }));

  const pairs = [];
  const malformed = [];
  const stack = [];
  for (const token of tokens) {
    if (token.type === 'open') {
      stack.push(token);
      continue;
    }
    if (!stack.length) {
      malformed.push({ start: token.start, end: token.end });
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
    tokens,
    malformed,
    unmatchedOpenings: [...stack],
    removablePairs,
  };
}

/**
 * @param {string} content
 * @param {{maxIterations?:number}} options
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

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const analysis = analyzeTokens(result);

    if (analysis.removablePairs.length) {
      removedBlocks += analysis.removablePairs.length;
      result = removeRanges(result, analysis.removablePairs, { trimLines: true });
      changed = true;
      continue;
    }

    // 没有可安全配对的完整块时，才处理“未闭合但后面有明确正文锚点”的泄漏。
    const anchors = findMatchesOutsideRanges(result, CLEAR_ANCHOR_RE, analysis.ranges);
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

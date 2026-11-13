// 纯文本扫描工具：识别代码围栏/行内代码保护区域，并在保护区域外查找标记。
// 不依赖宿主，供推理块清理与 SDC 结构修复共用，避免“演示代码被当成真实标签”。

function lineOffsets(text) {
  const lines = [];
  let start = 0;
  const matcher = /\n/g;
  let match;
  while ((match = matcher.exec(text)) !== null) {
    lines.push({ start, end: match.index + 1, text: text.slice(start, match.index) });
    start = match.index + 1;
  }
  lines.push({ start, end: text.length, text: text.slice(start) });
  return lines;
}

function openingFence(lineText) {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/.exec(lineText);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function closingFence(lineText, opening) {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(lineText);
  return !!match && match[1][0] === opening.char && match[1].length >= opening.length;
}

function findBacktickRun(source, from, length) {
  let index = from;
  while (index < source.length) {
    index = source.indexOf('`', index);
    if (index === -1) return -1;
    let run = 0;
    while (source[index + run] === '`') run++;
    if (run === length) return index;
    index += Math.max(run, 1);
  }
  return -1;
}

/**
 * 返回需要保护、不得修改的区域。包括 Markdown 围栏、行内反引号、
 * <code>/<pre> 块，避免清理器误改示例代码。
 * @param {string} text
 * @returns {Array<{start:number,end:number}>}
 */
export function findProtectedRanges(text) {
  const source = String(text ?? '');
  const ranges = [];
  const lines = lineOffsets(source);

  for (let i = 0; i < lines.length; i++) {
    const opening = openingFence(lines[i].text);
    if (!opening) continue;
    let closeLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closingFence(lines[j].text, opening)) { closeLine = j; break; }
    }
    if (closeLine >= 0) {
      ranges.push({ start: lines[i].start, end: lines[closeLine].end });
      i = closeLine;
    } else {
      // 未闭合围栏：保守保护到文本末尾，绝不在其中删除内容。
      ranges.push({ start: lines[i].start, end: source.length });
      break;
    }
  }

  // 行内反引号（位于围栏外）。匹配不到闭合时保护到行尾，避免误伤半截示例。
  const backtickRe = /(`+)/g;
  let tick;
  while ((tick = backtickRe.exec(source)) !== null) {
    const start = tick.index;
    if (isIndexProtected(ranges, start)) continue;
    const length = tick[1].length;
    const closerIndex = findBacktickRun(source, start + length, length);
    if (closerIndex >= 0) {
      ranges.push({ start, end: closerIndex + length });
      backtickRe.lastIndex = closerIndex + length;
    } else {
      const lineEnd = source.indexOf('\n', start);
      ranges.push({ start, end: lineEnd === -1 ? source.length : lineEnd });
    }
  }

  const codeBlockRe = /<(code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let block;
  while ((block = codeBlockRe.exec(source)) !== null) {
    ranges.push({ start: block.index, end: block.index + block[0].length });
  }

  return mergeRanges(ranges);
}

export function mergeRanges(ranges) {
  const sorted = ranges
    .filter(range => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ start: range.start, end: range.end });
  }
  return out;
}

export function isIndexProtected(ranges, index) {
  return ranges.some(range => index >= range.start && index < range.end);
}

/**
 * 在保护区域外查找所有匹配。返回带 index 的 Match 数组，不修改正则 lastIndex。
 */
export function findMatchesOutsideRanges(text, regex, ranges) {
  if (!(regex instanceof RegExp)) return [];
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  const out = [];
  let match;
  while ((match = matcher.exec(text)) !== null) {
    if (!isIndexProtected(ranges, match.index)) out.push(match);
    if (match[0].length === 0) matcher.lastIndex++;
  }
  return out;
}

function expandRemovalToLine(source, start, end) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = source.indexOf('\n', end);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const before = source.slice(lineStart, start);
  const after = source.slice(end, lineEnd);
  if (!before.trim() && !after.trim()) {
    return { start: lineStart, end: nextNewline === -1 ? source.length : nextNewline + 1 };
  }
  return { start, end };
}

/**
 * 按原文区间删除文本；可选 trimLines 会整行删除仅由标记组成的行。
 */
export function removeRanges(source, removals, { trimLines = false } = {}) {
  let ranges = removals
    .map(range => trimLines ? expandRemovalToLine(source, range.start, range.end) : { start: range.start, end: range.end })
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  ranges = mergeRanges(ranges);
  if (!ranges.length) return source;
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += source.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  out += source.slice(cursor);
  return out;
}

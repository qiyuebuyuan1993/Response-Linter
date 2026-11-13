// 正文外 <details> 折叠块顺序与配对修复（纯文本范围扫描）。
// 只重排“你的选择是”与“内心独白”两个完整目标块，不解析/重建正文 HTML。
// 复用 text-scan 的代码保护区域，并额外忽略 HTML 注释中的标签示例。
import {
  findHtmlCommentRanges,
  findMatchesOutsideRanges,
  findProtectedRanges,
  isIndexProtected,
  mergeRanges,
} from './text-scan.js';

export const DEFAULT_DETAILS_MONOLOGUE_KEYWORD = '内心独白';
export const DEFAULT_DETAILS_CHOICES_KEYWORD = '你的选择是';

const SDC_START_RE = /<!--\s*SDC-start\b[\s\S]*?-->/gi;
const SDC_END_RE = /<!--\s*SDC-end\b[\s\S]*?-->/gi;
const CONTENT_START_RE = /<content\b[^>]*>/gi;
const CONTENT_END_RE = /<\/content\s*>/gi;
const DETAILS_TAG_RE = /<(\/?)\s*(details|summary)\b[^>]*>/gi;

function keywordOf(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function resultOf(source) {
  return { content: source, changed: false, warnings: [], repairs: [] };
}

function tagTokens(source, ranges, from, to) {
  const tokens = [];
  const matcher = new RegExp(DETAILS_TAG_RE.source, 'gi');
  let match;
  while ((match = matcher.exec(source)) !== null) {
    if (match.index >= to) break;
    if (match.index + match[0].length <= from) continue;
    if (isIndexProtected(ranges, match.index)) continue;
    tokens.push({
      type: match[1] ? 'close' : 'open',
      name: match[2].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

/**
 * 扫描 details/summary 标签并建立真实的 details 嵌套区间。
 * summary 只归属于当前最近的 details；嵌套 details 内的 summary 属于内层。
 * 不完整或交叉的 summary / 多余结束标签会记录为结构问题。
 */
function parseDetails(source, ranges, from = 0, to = source.length) {
  const tokens = tagTokens(source, ranges, from, to);
  const nodes = [];
  const stack = [];
  const problems = [];
  let activeSummary = null;

  for (const token of tokens) {
    if (token.name === 'details') {
      if (token.type === 'open') {
        if (activeSummary) activeSummary.owner.summaryError = '标题内含 details 标签';
        const node = {
          openStart: token.start,
          openEnd: token.end,
          closeStart: null,
          closeEnd: null,
          parent: stack.length ? stack[stack.length - 1] : null,
          children: [],
          summary: null,
          summarySeen: false,
          summaryError: null,
        };
        if (node.parent) node.parent.children.push(node);
        nodes.push(node);
        stack.push(node);
      } else if (!stack.length) {
        problems.push('stray-details-close');
      } else {
        const node = stack.pop();
        if (activeSummary && activeSummary.owner === node) {
          node.summaryError = node.summaryError || 'summary 未闭合';
          activeSummary = null;
          problems.push('summary-unclosed');
        }
        node.closeStart = token.start;
        node.closeEnd = token.end;
      }
      continue;
    }

    // summary
    if (token.type === 'open') {
      if (activeSummary) {
        activeSummary.owner.summaryError = activeSummary.owner.summaryError || 'summary 嵌套';
        problems.push('summary-nested');
        continue;
      }
      if (!stack.length) {
        problems.push('summary-outside-details');
        continue;
      }
      const owner = stack[stack.length - 1];
      if (owner.summarySeen) {
        owner.summaryError = owner.summaryError || 'summary 重复';
        problems.push('summary-duplicate');
      }
      owner.summarySeen = true;
      activeSummary = { owner, openStart: token.start, openEnd: token.end, closeStart: null, closeEnd: null };
    } else if (!activeSummary) {
      problems.push('stray-summary-close');
    } else {
      const owner = activeSummary.owner;
      if (stack[stack.length - 1] !== owner) {
        owner.summaryError = owner.summaryError || 'summary 交叉';
        problems.push('summary-crossed');
      } else {
        activeSummary.closeStart = token.start;
        activeSummary.closeEnd = token.end;
        if (!owner.summary && !owner.summaryError) {
          owner.summary = {
            openStart: activeSummary.openStart,
            openEnd: activeSummary.openEnd,
            closeStart: activeSummary.closeStart,
            closeEnd: activeSummary.closeEnd,
            text: source.slice(activeSummary.openEnd, activeSummary.closeStart),
          };
        }
      }
      activeSummary = null;
    }
  }

  if (activeSummary) {
    activeSummary.owner.summaryError = activeSummary.owner.summaryError || 'summary 未闭合';
    problems.push('summary-unclosed');
  }

  return {
    nodes,
    tokens,
    unclosed: stack.slice(),
    problems,
    summaryProblems: problems.filter(problem => problem.startsWith('summary')),
  };
}

function visibleSummaryText(summaryText) {
  // 只看直接 summary 的可见纯文本：标题属性、HTML 注释、脚本/样式或嵌套标签里的关键词不算。
  return String(summaryText ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '');
}

function titleMatch(summaryText, monologueKeyword, choicesKeyword) {
  const text = visibleSummaryText(summaryText);
  const monologue = text.includes(monologueKeyword);
  const choices = text.includes(choicesKeyword);
  return { monologue, choices, both: monologue && choices };
}

function targetRole(node, monologueKeyword, choicesKeyword) {
  if (!node || !node.summary || node.summaryError) return null;
  const match = titleMatch(node.summary.text, monologueKeyword, choicesKeyword);
  return match.both ? null : (match.monologue ? 'monologue' : (match.choices ? 'choices' : null));
}

function topLevelTargets(parse, monologueKeyword, choicesKeyword) {
  const monologue = [];
  const choices = [];
  const both = [];
  const nested = [];
  const unknown = [];
  for (const node of parse.nodes) {
    if (!node.closeStart || !node.summary || node.summaryError) continue;
    const match = titleMatch(node.summary.text, monologueKeyword, choicesKeyword);
    if (node.parent) {
      if (match.monologue || match.choices) nested.push(node);
      continue;
    }
    if (match.both) both.push(node);
    else if (match.monologue) monologue.push(node);
    else if (match.choices) choices.push(node);
    else unknown.push(node);
  }
  return { monologue, choices, both, nested, unknown };
}

function classifiedTargetWarnings(targets) {
  const warnings = [];
  for (let index = 0; index < targets.both.length; index++) {
    // 不把模型提供的标题原文拼进警告，避免它进入未经转义的 HTML toast 路径。
    warnings.push('检测到一个顶层折叠块的标题同时匹配“内心独白”和“你的选择是”两个关键词，无法确定目标；已保留原文，未排序。');
  }
  if (targets.monologue.length > 1) {
    warnings.push(`检测到 ${targets.monologue.length} 个标题含“内心独白”的顶层折叠块，目标重复且不唯一；已保留原文，未排序。`);
  }
  if (targets.choices.length > 1) {
    warnings.push(`检测到 ${targets.choices.length} 个标题含“你的选择是”的顶层折叠块，目标重复且不唯一；已保留原文，未排序。`);
  }
  if (!warnings.length && !targets.nested.length && targets.unknown.length &&
    ((targets.monologue.length === 1 && targets.choices.length === 0) ||
      (targets.choices.length === 1 && targets.monologue.length === 0))) {
    const found = targets.monologue.length ? '“内心独白”' : '“你的选择是”';
    warnings.push(`只识别到一个目标折叠块（${found}），另一个顶层折叠块的标题无法识别；已保留原文，未排序。`);
  }
  return warnings;
}

function lineEndingBefore(source, index) {
  if (index <= 0 || source[index - 1] !== '\n') return null;
  return index >= 2 && source[index - 2] === '\r' ? '\r\n' : '\n';
}

function closeInsertion(source, index) {
  const eol = lineEndingBefore(source, index);
  return eol ? `</details>${eol}` : '</details>';
}

function hasTrailingProse(source, index, end) {
  return source.slice(index, end).trim() !== '';
}

function externalContentTags(source, ranges, from, to) {
  const found = [];
  for (const regex of [CONTENT_START_RE, CONTENT_END_RE]) {
    for (const match of findMatchesOutsideRanges(source, regex, ranges)) {
      if (match.index >= from && match.index + match[0].length <= to) found.push(match);
    }
  }
  return found;
}

function tryRepairUnclosedClose(source, ranges, externalStart, parse, externalEnd, monologueKeyword, choicesKeyword) {
  if (parse.unclosed.length !== 1) return { ok: false, reason: 'multiple-unclosed' };
  const node = parse.unclosed[0];
  if (node.parent) return { ok: false, reason: 'nested-unclosed' };
  const nodeRole = targetRole(node, monologueKeyword, choicesKeyword);
  if (!nodeRole) return { ok: false, reason: 'unclosed-unknown-root' };
  if (!node.children.length) return { ok: false, reason: 'no-sibling-evidence' };
  const firstChild = node.children[0];
  // 只有“目标角色 + 下一个完整折叠块是对面目标角色”才是可推断的并列证据。
  // 未知外层 / 未知子块即使标题齐全也不能据此扁平化，否则可能破坏嵌套结构。
  const childRole = targetRole(firstChild, monologueKeyword, choicesKeyword);
  if (!childRole || childRole === nodeRole) return { ok: false, reason: 'no-parallel-role-evidence' };
  for (const child of node.children) {
    if (!child.closeStart || !child.summary || child.summaryError) return { ok: false, reason: 'ambiguous-child' };
  }
  if (!firstChild.closeStart) return { ok: false, reason: 'ambiguous-child' };
  // 未闭合块之后若仍有普通文字，归属可能是块内也可能是块外，不能擅自补闭合。
  const lastClose = Math.max(...node.children.map(child => child.closeEnd));
  if (hasTrailingProse(source, lastClose, externalEnd)) return { ok: false, reason: 'trailing-prose' };

  const insertion = closeInsertion(source, firstChild.openStart);
  const candidate = source.slice(0, firstChild.openStart) + insertion + source.slice(firstChild.openStart);
  // 插入点之后的保护区域会整体右移；必须按候选文本重新计算，避免把代码示例当成真实标签。
  const candidateRanges = mergeRanges([...findProtectedRanges(candidate), ...findHtmlCommentRanges(candidate)]);
  const candidateParse = parseDetails(candidate, candidateRanges, externalStart, candidate.length);
  if (candidateParse.unclosed.length || candidateParse.problems.length) {
    return { ok: false, reason: 'candidate-unbalanced' };
  }
  return { ok: true, source: candidate, parse: candidateParse, repairs: ['inserted-details-close'] };
}

/**
 * 修复正文外两个目标折叠块的顺序与明显可推断的缺失闭合标签。
 * 只处理已存在 SDC-start/SDC-end、且 SDC-end 与 </content> 之间仅有空白的文本；
 * 不会为了本功能移动正文边界，也不会新增非 SDC 支持。
 *
 * @param {string} content
 * @param {{monologueKeyword?:string, choicesKeyword?:string, boundaryEnabled?:boolean}} options
 * @returns {{content:string, changed:boolean, warnings:string[], repairs:string[]}}
 */
export function repairDetailsOutsideContent(content, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const base = resultOf(source);
  if (!source || !/<(?:\/)?\s*(?:details|summary)\b/i.test(source)) return base;

  const monologueKeyword = keywordOf(options.monologueKeyword, DEFAULT_DETAILS_MONOLOGUE_KEYWORD);
  const choicesKeyword = keywordOf(options.choicesKeyword, DEFAULT_DETAILS_CHOICES_KEYWORD);
  if (monologueKeyword === choicesKeyword) {
    base.warnings.push('“内心独白”和“你的选择是”标题关键词相同，无法区分目标；已保留原文。');
    return base;
  }

  const protectedRanges = findProtectedRanges(source);
  const commentProtections = mergeRanges([...protectedRanges, ...findHtmlCommentRanges(source)]);

  const starts = findMatchesOutsideRanges(source, SDC_START_RE, protectedRanges);
  const ends = findMatchesOutsideRanges(source, SDC_END_RE, protectedRanges);
  const contentStarts = findMatchesOutsideRanges(source, CONTENT_START_RE, commentProtections);
  const contentEnds = findMatchesOutsideRanges(source, CONTENT_END_RE, commentProtections);

  // 普通回复/没有 SDC 标记：本功能完全不介入，也不新增非 SDC 支持。
  if (!starts.length && !ends.length) return base;
  if (!starts.length || !ends.length) {
    base.warnings.push('SDC 标记不完整（需要同时存在 SDC-start 与 SDC-end）；已跳过正文外折叠块处理。');
    return base;
  }
  if (starts.length > 1 || ends.length > 1) {
    base.warnings.push('检测到重复的 SDC 标记，正文边界不明确；已跳过正文外折叠块处理。');
    return base;
  }
  if (contentStarts.length > 1 || contentEnds.length > 1) {
    base.warnings.push('检测到多个 <content> 起始或结束标签，正文范围不明确；已跳过正文外折叠块处理。');
    return base;
  }
  if (!contentStarts.length || !contentEnds.length) {
    base.warnings.push('发现 SDC 标记但缺少完整的 <content> 标签；已跳过正文外折叠块处理。');
    return base;
  }

  const start = starts[0];
  const end = ends[0];
  const contentStart = contentStarts[0];
  const close = contentEnds[0];
  if (contentStart.index >= start.index || end.index < start.index + start[0].length) {
    base.warnings.push('SDC-start 不在 <content> 起始之后或位于 SDC-end 之后，正文边界不明确；已跳过正文外折叠块处理。');
    return base;
  }
  if (close.index < end.index + end[0].length) {
    base.warnings.push('SDC-end 未位于 </content> 之前，正文边界尚未修复；已跳过正文外折叠块处理。');
    return base;
  }
  if (!/^\s*$/.test(source.slice(end.index + end[0].length, close.index))) {
    base.warnings.push('SDC-end 与 </content> 之间仍有正文/标记，正文边界尚未安全；已跳过正文外折叠块处理。');
    return base;
  }

  const externalStart = close.index + close[0].length;
  const externalEnd = source.length;
  const contentBodyStart = contentStart.index + contentStart[0].length;
  const contentBodyEnd = close.index;

  // 目标块仍被 </content> 包在正文里时，不用本开关偷偷移动边界。
  const globalParse = parseDetails(source, commentProtections, 0, source.length);
  const insideTarget = globalParse.nodes.find(node => {
    if (!node.closeStart || !node.summary || node.summaryError) return false;
    if (node.openStart < contentBodyStart || node.closeEnd > contentBodyEnd) return false;
    const match = titleMatch(node.summary.text, monologueKeyword, choicesKeyword);
    return match.monologue || match.choices;
  });
  if (insideTarget) {
    // 同样只给通用说明，不回显模型可控的 summary 原文。
    base.warnings.push(options.boundaryEnabled === false
      ? '检测到标题含目标关键词的折叠块仍在 </content> 之前；未启用“修复 SDC / 正文边界”时不会移动正文边界，已跳过折叠块排序。'
      : '检测到标题含目标关键词的折叠块仍在 </content> 之前，正文边界未安全修复；已跳过折叠块排序。');
    return base;
  }

  if (externalContentTags(source, commentProtections, externalStart, externalEnd).length) {
    base.warnings.push('正文外检测到 <content> 标签，无法确认折叠块归属；已保留原文，未排序或补闭合。');
    return base;
  }

  let workingSource = source;
  const repairs = [];
  let parse = parseDetails(workingSource, commentProtections, externalStart, workingSource.length);

  if (parse.summaryProblems.length) {
    base.warnings.push('正文外折叠块标题（summary）结构不完整或交叉；已保留原文，未排序或补闭合。');
    return base;
  }
  if (parse.problems.length) {
    base.warnings.push('正文外折叠块层级结构不明确（存在多余结束标签等）；已保留原文，未排序或补闭合。');
    return base;
  }
  if (parse.unclosed.length) {
    const repaired = tryRepairUnclosedClose(
      workingSource,
      commentProtections,
      externalStart,
      parse,
      workingSource.length,
      monologueKeyword,
      choicesKeyword,
    );
    if (!repaired.ok) {
      base.warnings.push('正文外折叠块存在未闭合的 details，且无法明确判断缺失结束标签的归属；已保留原文，未排序或补闭合。');
      return base;
    }
    workingSource = repaired.source;
    parse = repaired.parse;
    repairs.push(...repaired.repairs);
  }
  if (parse.summaryProblems.length) {
    base.warnings.push('正文外折叠块标题（summary）结构不完整或交叉；已保留原文，未排序或补闭合。');
    return base;
  }
  if (parse.unclosed.length) {
    base.warnings.push('正文外折叠块结构仍不完整；已保留原文，未排序或补闭合。');
    return base;
  }

  const targets = topLevelTargets(parse, monologueKeyword, choicesKeyword);
  const ambiguityWarnings = classifiedTargetWarnings(targets);
  if (ambiguityWarnings.length) {
    // 目标本身不唯一时连补闭合也不做，确保原文完全不动。
    base.warnings.push(...ambiguityWarnings);
    return base;
  }

  let repairedSource = workingSource;
  const choices = targets.choices[0] || null;
  const monologue = targets.monologue[0] || null;
  if (choices && monologue && choices.openStart < monologue.openStart) {
    repairedSource = repairedSource.slice(0, choices.openStart) +
      repairedSource.slice(monologue.openStart, monologue.closeEnd) +
      repairedSource.slice(choices.closeEnd, monologue.openStart) +
      repairedSource.slice(choices.openStart, choices.closeEnd) +
      repairedSource.slice(monologue.closeEnd);
    repairs.push('swapped-details-targets');
  }

  if (repairedSource === source) return base;
  return {
    content: repairedSource,
    changed: true,
    warnings: [],
    repairs,
  };
}

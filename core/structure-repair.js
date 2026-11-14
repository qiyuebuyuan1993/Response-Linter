// Generalized reply-structure repair driven by one validated profile descriptor.
// This module is deliberately pure: it does not read/write host state and it
// never executes user JavaScript or user-supplied regular expressions.
import {
  DEFAULT_ADVANCE_MINUTES,
  MAX_ADVANCE_MINUTES,
  advanceCalendarTime,
  formatDateText,
  formatTimeText,
  formatWeekday,
  parseDateText,
  parseTimeText,
  parseWeekday,
} from './calendar-engine.js';
import {
  findHtmlCommentRanges,
  findMatchesOutsideRanges,
  findProtectedRanges,
  isIndexProtected,
  mergeRanges,
  removeRanges,
} from './text-scan.js';
import {
  buildDelimiterPattern,
  compileMarkerTemplate,
  isHtmlTagDelimiter,
  tagNameOf,
  validateMarkerTemplate,
} from './structure-profiles.js';

const SDC_START_RE = /<!--\s*SDC-start\b([\s\S]*?)-->/gi;
const SDC_END_RE = /<!--\s*SDC-end\b([\s\S]*?)-->/gi;
const HTML_TAG_RE = /<\s*(\/?)\s*([^\s/>]+)(?:\s[^>]*)?>/gi;
const SELF_CLOSING_RE = /\/\s*>$/;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function resultBase(source) {
  return { content: source, changed: false, warnings: [], repairs: [] };
}

function uniqueWarnings(warnings) {
  return [...new Set(warnings.filter(item => typeof item === 'string' && item))];
}

function parseSdcMarkerFields(inner) {
  const fields = {};
  for (const part of String(inner ?? '').split(/[|｜]/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[=:：]\s*([\s\S]*?)\s*$/.exec(part);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  return fields;
}

function matchRangeAtComment(match, commentRanges) {
  const range = commentRanges.find(item => match.index >= item.start && match.index + match[0].length <= item.end);
  if (!range) return true;
  return range.start === match.index && range.end === match.index + match[0].length;
}

function findTimeMarkers(text, profile, protectedRanges, commentRanges) {
  const mode = profile.time?.mode;
  if (mode === 'sdc') {
    return {
      starts: findMatchesOutsideRanges(text, SDC_START_RE, protectedRanges)
        .filter(match => matchRangeAtComment(match, commentRanges)),
      ends: findMatchesOutsideRanges(text, SDC_END_RE, protectedRanges)
        .filter(match => matchRangeAtComment(match, commentRanges)),
    };
  }
  if (mode === 'custom') {
    // Custom time templates are user literals and stay case-exact, matching
    // literal body/trailing delimiters. Only HTML tag names are case-folded.
    const startRe = compileMarkerTemplate(profile.time.startTemplate, 'g');
    const endRe = compileMarkerTemplate(profile.time.endTemplate, 'g');
    return {
      starts: startRe ? findMatchesOutsideRanges(text, startRe, protectedRanges)
        .filter(match => matchRangeAtComment(match, commentRanges)) : [],
      ends: endRe ? findMatchesOutsideRanges(text, endRe, protectedRanges)
        .filter(match => matchRangeAtComment(match, commentRanges)) : [],
    };
  }
  return { starts: [], ends: [] };
}

function findDelimiterMatches(text, delimiter, ranges, { open = true } = {}) {
  const pattern = buildDelimiterPattern(delimiter, { open });
  if (!pattern) return [];
  // HTML tag names are case-insensitive per host conventions; literal
  // non-tag delimiters are byte/case-exact as configured.
  const flags = isHtmlTagDelimiter(delimiter) ? 'gi' : 'g';
  try {
    return findMatchesOutsideRanges(text, new RegExp(pattern, flags), ranges);
  } catch {
    return [];
  }
}

function findExternalBoundary(text, from, profile, ranges) {
  const candidates = [];
  const markers = [
    ...(profile.auxiliaries || []),
    // Configured trailing blocks are also valid external boundaries. Without
    // this, a custom profile with no explicit watermark could never move the
    // body close before its trailing blocks.
    ...(profile.blocks || []).map(block => block.open),
  ];
  for (const marker of [...new Set(markers.filter(Boolean))]) {
    for (const match of findDelimiterMatches(text, marker, ranges, { open: true })) {
      if (match.index >= from) candidates.push({ index: match.index, markerIndex: match.index, marker: match[0], sourceMarker: marker });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.index - right.index || right.marker.length - left.marker.length);
  const marker = candidates[0];
  const before = text.slice(0, marker.index);
  // A horizontal rule immediately before the first auxiliary marker belongs
  // outside the body; keep it byte-for-byte with the auxiliary region.
  const separator = /(^|\r?\n)[ \t]*-{3,}[ \t]*(?:\r?\n[ \t]*)$/.exec(before);
  if (separator) {
    return {
      ...marker,
      index: separator.index + separator[1].length,
      hasSeparator: true,
    };
  }
  return { ...marker, hasSeparator: false };
}

function buildTokenBlock(narrative, endText, closeText, hasFollowing) {
  let body = String(narrative ?? '').replace(/[ \t\r\n]+$/, '');
  let block = body;
  if (block && !block.endsWith('\n')) block += '\n';
  block += endText;
  block += '\n';
  block += closeText;
  if (hasFollowing) block += '\n';
  return block;
}

function resolveCalendarOnDemand(options) {
  if (options.calendarResult) return options.calendarResult;
  if (options.calendar) {
    return { ok: true, calendar: options.calendar, source: options.source || null, sourceLabel: options.sourceLabel || null };
  }
  if (typeof options.resolveCalendar === 'function') {
    try { return options.resolveCalendar(); } catch (error) {
      return { ok: false, source: options.source || null, error: error?.message || String(error) };
    }
  }
  return null;
}

function synthesisError(message) {
  return `未能合成时间结束标记：${message} 请手动补全结束标记中的 date/weekday/time，或检查历法来源；未伪造结束日期。`;
}

function formatTemplate(template, values) {
  return String(template).replace(/\{(date|weekday|time)\}/g, (_, key) => values[key]);
}

function parseCustomMarker(match, template) {
  const checked = validateMarkerTemplate(template);
  if (!checked.ok) return null;
  const groups = match?.groups || {};
  const date = groups.date == null ? '' : String(groups.date).trim();
  const weekday = groups.weekday == null ? '' : String(groups.weekday).trim();
  const time = groups.time == null ? '' : String(groups.time).trim();
  return { date, weekday, time };
}

/**
 * Synthesize the configured end marker from the matching start marker.
 * Existing markers are never rewritten; this is called only when an end marker
 * is missing and valid start fields plus a calendar are available.
 */
export function synthesizeProfileTimeEnd(startMarkerText, timeConfig, calendar, advanceMinutes = DEFAULT_ADVANCE_MINUTES) {
  if (!calendar) return { ok: false, error: '历法来源不可用' };
  const mode = timeConfig?.mode;
  if (mode === 'sdc') {
    const marker = /<!--\s*SDC-start\b([\s\S]*?)-->/i.exec(String(startMarkerText ?? ''));
    if (!marker) return { ok: false, error: '缺少 SDC-start' };
    const fields = parseSdcMarkerFields(marker[1]);
    const dateText = fields.date;
    const weekdayText = fields.weekday ?? fields['星期'];
    const timeText = fields.time;
    if (!dateText) return { ok: false, error: 'SDC-start 缺少 date 字段' };
    if (!weekdayText) return { ok: false, error: 'SDC-start 缺少 weekday 字段' };
    if (!timeText) return { ok: false, error: 'SDC-start 缺少 time 字段' };
    const date = parseDateText(dateText, calendar);
    if (!date) return { ok: false, error: `日期「${dateText}」不符合当前历法（仅支持阿拉伯数字年月日）` };
    const weekdayIndex = parseWeekday(weekdayText, calendar);
    if (weekdayIndex == null) return { ok: false, error: `weekday 字段「${weekdayText}」不在当前配置的星期标签中` };
    const time = parseTimeText(timeText);
    if (!time) return { ok: false, error: `time 字段「${timeText}」无效` };
    const minutes = Number.isInteger(advanceMinutes) && advanceMinutes >= 1 && advanceMinutes <= MAX_ADVANCE_MINUTES
      ? advanceMinutes : calendar.advanceMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ADVANCE_MINUTES) {
      return { ok: false, error: '推进分钟配置无效' };
    }
    const advanced = advanceCalendarTime({ calendar, date, weekdayIndex, time, advanceMinutes: minutes });
    if (!advanced.ok) return { ok: false, error: advanced.error };
    const nextDate = formatDateText(calendar, advanced.date);
    const nextWeekday = formatWeekday(calendar, advanced.weekdayIndex);
    const nextTime = formatTimeText(advanced.time);
    if (!nextDate || !nextWeekday || !nextTime) return { ok: false, error: '历法格式化失败' };
    return {
      ok: true,
      text: `<!-- SDC-end | date=${nextDate} | weekday=${nextWeekday} | time=${nextTime} -->`,
      advanced,
    };
  }
  if (mode === 'custom') {
    const re = compileMarkerTemplate(timeConfig.startTemplate, 'g');
    const match = re ? re.exec(String(startMarkerText ?? '')) : null;
    const fields = match ? parseCustomMarker(match, timeConfig.startTemplate) : null;
    if (!fields) return { ok: false, error: '无法解析自定义开始时间标记' };
    if (!fields.date) return { ok: false, error: '开始标记缺少日期' };
    if (!fields.weekday) return { ok: false, error: '开始标记缺少星期' };
    if (!fields.time) return { ok: false, error: '开始标记缺少时间' };
    const date = parseDateText(fields.date, calendar);
    if (!date) return { ok: false, error: `日期「${fields.date}」不符合当前历法（仅支持阿拉伯数字年月日）` };
    const weekdayIndex = parseWeekday(fields.weekday, calendar);
    if (weekdayIndex == null) return { ok: false, error: `星期「${fields.weekday}」不在当前配置的星期标签中` };
    const time = parseTimeText(fields.time);
    if (!time) return { ok: false, error: `时间「${fields.time}」无效` };
    const minutes = Number.isInteger(advanceMinutes) && advanceMinutes >= 1 && advanceMinutes <= MAX_ADVANCE_MINUTES
      ? advanceMinutes : calendar.advanceMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ADVANCE_MINUTES) {
      return { ok: false, error: '推进分钟配置无效' };
    }
    const advanced = advanceCalendarTime({ calendar, date, weekdayIndex, time, advanceMinutes: minutes });
    if (!advanced.ok) return { ok: false, error: advanced.error };
    const nextDate = formatDateText(calendar, advanced.date);
    const nextWeekday = formatWeekday(calendar, advanced.weekdayIndex);
    const nextTime = formatTimeText(advanced.time);
    if (!nextDate || !nextWeekday || !nextTime) return { ok: false, error: '历法格式化失败' };
    return {
      ok: true,
      text: formatTemplate(timeConfig.endTemplate, { date: nextDate, weekday: nextWeekday, time: nextTime }),
      advanced,
    };
  }
  return { ok: false, error: '当前档案未使用时间标记' };
}

/**
 * Body-pair and time-marker boundary repair. Only whitespace between the time
 * end marker and body close is normalized; every other source byte is retained.
 */
export function repairProfileBodyBoundary(content, profile, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const base = resultBase(source);
  if (!profile?.body?.open || !profile?.body?.close) {
    base.warnings.push('结构配置档案缺少正文开始/结束分隔符，已保留原文。');
    return base;
  }
  if (!source) return base;

  const protectedRanges = findProtectedRanges(source);
  const structuralRanges = mergeRanges([...protectedRanges, ...findHtmlCommentRanges(source)]);
  const bodyStarts = findDelimiterMatches(source, profile.body.open, structuralRanges, { open: true });
  const bodyCloses = findDelimiterMatches(source, profile.body.close, structuralRanges, { open: false });

  if (!bodyStarts.length) {
    if (bodyCloses.length) base.warnings.push('只发现正文结束分隔符而没有开始分隔符；已保留原文。');
    return base;
  }
  if (bodyStarts.length > 1) {
    base.warnings.push('检测到重复的正文开始分隔符，正文边界不明确；已保留原文。');
    return base;
  }
  if (bodyCloses.length > 1) {
    base.warnings.push('检测到重复的正文结束分隔符，正文边界不明确；已保留原文。');
    return base;
  }

  const bodyStart = bodyStarts[0];
  const bodyClose = bodyCloses[0] || null;
  const bodyBodyStart = bodyStart.index + bodyStart[0].length;
  const boundary = findExternalBoundary(source, bodyBodyStart, profile, structuralRanges);
  const regionEnd = boundary ? boundary.index : source.length;

  if (profile.time?.mode === 'none') {
    if (!boundary) {
      if (!bodyClose) {
        base.warnings.push('缺少正文结束分隔符，且没有配置可定位的外部标记；未猜测结束位置，已保留原文。');
      }
      return base;
    }
    if (bodyClose && bodyClose.index < bodyBodyStart) {
      base.warnings.push('正文结束分隔符出现在开始分隔符之前，结构不明确；已保留原文。');
      return base;
    }
    if (bodyClose && bodyClose.index <= boundary.index) return base;
    const narrative = source.slice(bodyBodyStart, regionEnd).replace(/[ \t\r\n]+$/, '');
    const closeText = profile.body.close;
    const insertion = `${narrative}${narrative ? '\n' : ''}${closeText}\n`;
    let after = source.slice(regionEnd);
    if (bodyClose && bodyClose.index >= boundary.index) {
      after = removeRanges(after, [{
        start: bodyClose.index - regionEnd,
        end: bodyClose.index + bodyClose[0].length - regionEnd,
      }], { trimLines: true });
    }
    base.content = source.slice(0, bodyBodyStart) + insertion + after;
    base.changed = true;
    base.repairs = [bodyClose ? 'moved-body-close' : 'added-body-close'];
    return base;
  }

  // SDC/custom time modes discover markers even when the marker is itself an
  // HTML comment. Comment examples are excluded unless the whole comment is
  // exactly the configured marker.
  const markerCommentRanges = findHtmlCommentRanges(source);
  const markers = findTimeMarkers(source, profile, protectedRanges, markerCommentRanges);
  const { starts, ends } = markers;
  if (!starts.length && !ends.length) return base;
  if (starts.length > 1 || ends.length > 1) {
    base.warnings.push('检测到重复的时间开始/结束标记，边界不明确；已保留原文。');
    return base;
  }
  if (!starts.length) {
    base.warnings.push('只发现时间结束标记而没有开始标记；不会凭空发明起始日期，已保留原文。');
    return base;
  }
  const start = starts[0];
  const end = ends[0] || null;
  if (bodyStart.index >= start.index) {
    base.warnings.push('正文开始分隔符出现在时间开始标记之后，结构不明确；已保留原文。');
    return base;
  }
  if (end && end.index < start.index + start[0].length) {
    base.warnings.push('时间结束标记出现在开始标记之前或内部，结构不明确；已保留原文。');
    return base;
  }

  const endInside = end && end.index >= bodyBodyStart && end.index <= regionEnd;
  const closeInside = bodyClose && bodyClose.index >= bodyBodyStart && bodyClose.index <= regionEnd;
  const endToClose = end && bodyClose && end.index < bodyClose.index
    ? source.slice(end.index + end[0].length, bodyClose.index)
    : null;
  const closeToBoundary = bodyClose ? source.slice(bodyClose.index + bodyClose[0].length, regionEnd) : null;
  const alreadyCorrectPair = !!end && !!bodyClose && endInside && closeInside &&
    end.index < bodyClose.index && /^\s*$/.test(endToClose);
  // With no configured auxiliary marker, the body close itself ends the body.
  // Unknown content after it is external; do not extend the body to EOF just
  // because there is no known external marker.
  const alreadyCorrect = alreadyCorrectPair && (boundary ? /^\s*$/.test(closeToBoundary) : true);
  if (alreadyCorrect) return base;

  let endText = end ? end[0] : null;
  let synthesized = false;
  if (!endText) {
    // Calendar is needed only for a genuinely missing end marker. Moving an
    // existing marker must not trigger a calendar warning.
    const calendarInfo = resolveCalendarOnDemand(options);
    const calendar = calendarInfo?.calendar;
    if (!calendarInfo?.ok || !calendar) {
      base.warnings.push(synthesisError(calendarInfo?.error || '没有可用的历法来源（请检查所选历法）'));
      return base;
    }
    const advanceMinutes = calendarInfo.source === 'custom' && calendar.advanceMinutesExplicit
      ? calendar.advanceMinutes
      : options.advanceMinutes;
    const synth = synthesizeProfileTimeEnd(start[0], profile.time, calendar, advanceMinutes);
    if (!synth.ok) {
      base.warnings.push(synthesisError(synth.error));
      return base;
    }
    endText = synth.text;
    synthesized = true;
    base.calendar = calendar;
    base.source = calendarInfo.source ?? base.source ?? null;
    base.sourceLabel = calendarInfo.sourceLabel ?? null;
  }

  const closeText = bodyClose ? bodyClose[0] : profile.body.close;
  const removals = [];
  if (end) removals.push({ start: end.index, end: end.index + end[0].length });
  if (bodyClose) removals.push({ start: bodyClose.index, end: bodyClose.index + bodyClose[0].length });

  const narrative = source.slice(bodyBodyStart, regionEnd);
  const narrativeRanges = removals
    .filter(range => range.end > bodyBodyStart && range.start < regionEnd)
    .map(range => ({
      start: Math.max(range.start, bodyBodyStart) - bodyBodyStart,
      end: Math.min(range.end, regionEnd) - bodyBodyStart,
    }));
  const narrativeClean = removeRanges(narrative, narrativeRanges, { trimLines: true });

  const afterBoundary = source.slice(regionEnd);
  const afterRanges = removals
    .filter(range => range.end > regionEnd)
    .map(range => ({ start: Math.max(range.start, regionEnd) - regionEnd, end: range.end - regionEnd }));
  const afterClean = removeRanges(afterBoundary, afterRanges, { trimLines: true });

  const tokenBlock = buildTokenBlock(narrativeClean, endText, closeText, !!boundary);
  const repaired = source.slice(0, bodyBodyStart) + tokenBlock + (boundary ? afterClean : '');
  if (repaired === source) return base;

  base.content = repaired;
  base.changed = true;
  base.calendar = base.calendar || null;
  base.synthesizedEnd = synthesized;
  if (end) base.repairs.push('moved-time-end');
  else base.repairs.push('synthesized-time-end');
  if (bodyClose) base.repairs.push('moved-body-close');
  else base.repairs.push('added-body-close');
  return base;
}

function visibleText(source) {
  return String(source ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '');
}

function makeHtmlTokens(source, ranges) {
  const tokens = [];
  const matcher = new RegExp(HTML_TAG_RE.source, 'gi');
  let match;
  while ((match = matcher.exec(source)) !== null) {
    if (isIndexProtected(ranges, match.index)) continue;
    const closing = !!match[1];
    const name = match[2].toLowerCase();
    if (!closing && (SELF_CLOSING_RE.test(match[0]) || VOID_TAGS.has(name))) continue;
    tokens.push({
      kind: 'html',
      type: closing ? 'close' : 'open',
      name,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return tokens;
}

function makeLiteralTokens(source, profile, ranges) {
  const tokens = [];
  for (const block of profile.blocks || []) {
    if (isHtmlTagDelimiter(block.open)) continue;
    for (const match of findDelimiterMatches(source, block.open, ranges, { open: true })) {
      tokens.push({
        kind: 'literal',
        type: 'open',
        blockId: block.id,
        name: block.id,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
  }
  for (const block of profile.blocks || []) {
    if (isHtmlTagDelimiter(block.close)) continue;
    for (const match of findDelimiterMatches(source, block.close, ranges, { open: false })) {
      tokens.push({
        kind: 'literal',
        type: 'close',
        blockId: block.id,
        name: block.id,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
  }
  return tokens;
}

function parseProfileBlocks(source, ranges, profile, from = 0, to = source.length) {
  const htmlTokens = makeHtmlTokens(source, ranges).filter(token => token.start >= from && token.end <= to);
  const literalTokens = makeLiteralTokens(source, profile, ranges).filter(token => token.start >= from && token.end <= to);
  const tokens = [...htmlTokens, ...literalTokens].sort((left, right) =>
    left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const nodes = [];
  const stack = [];
  const problems = [];

  for (const token of tokens) {
    if (token.type === 'open') {
      const node = {
        kind: token.kind,
        tagName: token.kind === 'html' ? token.name : null,
        literalId: token.kind === 'literal' ? token.blockId : null,
        openText: token.text,
        openStart: token.start,
        openEnd: token.end,
        closeStart: null,
        closeEnd: null,
        parent: stack.length ? stack[stack.length - 1] : null,
        children: [],
      };
      if (node.parent) node.parent.children.push(node);
      nodes.push(node);
      stack.push(node);
      continue;
    }
    const top = stack[stack.length - 1];
    const matches = top && (token.kind === 'html'
      ? top.kind === 'html' && top.tagName === token.name
      : top.kind === 'literal' && top.literalId === token.blockId);
    if (!matches) {
      problems.push('mismatched-close');
      // Do not guess a matching ancestor; any such structure is preserved.
      continue;
    }
    stack.pop();
    top.closeStart = token.start;
    top.closeEnd = token.end;
  }

  return { nodes, tokens, unclosed: stack.slice(), problems, from, to };
}

function directTitleNode(node, block) {
  if (!block.titleTag) return null;
  const titleTag = block.titleTag.toLowerCase();
  const candidates = node.children.filter(child => child.tagName === titleTag);
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function classifyBlock(source, node, profile) {
  // Identity can be known from the opening tag/direct title even when the
  // outer close is missing; callers that reorder still require closeStart.
  if (!node) return { identity: null, ambiguous: false };
  const candidates = [];
  for (const block of profile.blocks || []) {
    const openTag = tagNameOf(block.open);
    const literal = !isHtmlTagDelimiter(block.open);
    if (openTag) {
      if (node.kind !== 'html' || node.tagName !== openTag) continue;
    } else if (literal) {
      if (node.kind !== 'literal' || node.literalId !== block.id) continue;
    }
    if (block.titleTag) {
      const titleNode = directTitleNode(node, block);
      if (!titleNode || !titleNode.closeStart) continue;
      const text = visibleText(source.slice(titleNode.openEnd, titleNode.closeStart));
      if (!text.includes(block.titleKeyword)) continue;
    }
    candidates.push(block);
  }
  if (!candidates.length) return { identity: null, ambiguous: false };
  if (candidates.length === 1) return { identity: candidates[0], ambiguous: false };
  return { identity: null, ambiguous: true };
}

function closeInsertion(source, index, closeText) {
  if (index <= 0 || source[index - 1] !== '\n') return closeText;
  const eol = index >= 2 && source[index - 2] === '\r' ? '\r\n' : '\n';
  return `${closeText}${eol}`;
}

function healthOf(parse) {
  return parse.problems.length === 0 && parse.unclosed.length === 0;
}

function classifyTopLevel(source, parse, profile) {
  const top = [];
  const nested = [];
  const ambiguous = [];
  for (const node of parse.nodes) {
    if (!node.closeStart) continue;
    const match = classifyBlock(source, node, profile);
    if (match.ambiguous) {
      ambiguous.push(node);
      continue;
    }
    if (!match.identity) continue;
    if (node.parent) nested.push({ node, identity: match.identity });
    else top.push({ node, identity: match.identity });
  }
  return { top, nested, ambiguous };
}

function tryRepairMissingClose(source, ranges, profile, parse, externalStart, externalEnd) {
  if (parse.problems.length) return { ok: false, reason: 'structure-problems' };
  if (parse.unclosed.length !== 1) return { ok: false, reason: 'multiple-unclosed' };
  const node = parse.unclosed[0];
  if (node.parent) return { ok: false, reason: 'nested-unclosed' };
  const rootMatch = classifyBlock(source, node, profile);
  if (!rootMatch.identity || rootMatch.ambiguous) return { ok: false, reason: 'unclosed-unknown-root' };

  const titleTag = rootMatch.identity.titleTag ? rootMatch.identity.titleTag.toLowerCase() : '';
  const evidenceChildren = node.children.filter(child =>
    !(child.kind === 'html' && titleTag && child.tagName === titleTag));
  const targetChildren = [];
  for (const child of evidenceChildren) {
    if (!child.closeStart) return { ok: false, reason: 'ambiguous-child' };
    const match = classifyBlock(source, child, profile);
    if (!match.identity || match.ambiguous) return { ok: false, reason: 'ambiguous-child' };
    targetChildren.push({ child, identity: match.identity });
  }
  if (!targetChildren.length) return { ok: false, reason: 'no-sibling-evidence' };
  for (const item of targetChildren) {
    if (item.identity.id === rootMatch.identity.id) return { ok: false, reason: 'no-parallel-role-evidence' };
  }
  const lastClose = Math.max(...targetChildren.map(item => item.child.closeEnd));
  if (source.slice(lastClose, externalEnd).trim() !== '') return { ok: false, reason: 'trailing-prose' };

  const insertion = closeInsertion(source, targetChildren[0].child.openStart, rootMatch.identity.close);
  const candidate = source.slice(0, targetChildren[0].child.openStart) + insertion + source.slice(targetChildren[0].child.openStart);
  const candidateRanges = mergeRanges([...findProtectedRanges(candidate), ...findHtmlCommentRanges(candidate)]);
  const candidateParse = parseProfileBlocks(candidate, candidateRanges, profile, externalStart, candidate.length);
  if (!healthOf(candidateParse)) return { ok: false, reason: 'candidate-unbalanced' };
  const candidateTargets = classifyTopLevel(candidate, candidateParse, profile);
  if (candidateTargets.ambiguous.length || candidateTargets.nested.length) {
    return { ok: false, reason: 'candidate-ambiguous' };
  }
  return { ok: true, source: candidate, parse: candidateParse, ranges: candidateRanges, repairs: ['inserted-block-close'] };
}

function findBodyPair(source, profile, protectedRanges, structuralRanges) {
  const starts = findDelimiterMatches(source, profile.body?.open, structuralRanges, { open: true });
  const closes = findDelimiterMatches(source, profile.body?.close, structuralRanges, { open: false });
  if (starts.length !== 1 || closes.length !== 1) {
    return { bodyStart: starts[0] || null, bodyClose: closes[0] || null, error: starts.length !== 1 ? 'body-start' : 'body-close' };
  }
  if (closes[0].index < starts[0].index) {
    return { bodyStart: starts[0], bodyClose: closes[0], error: 'body-order' };
  }
  return { bodyStart: starts[0], bodyClose: closes[0], error: null };
}

/**
 * Reorder configured complete top-level trailing blocks in their original
 * occupied slots. Text, unknown blocks and unconfigured nesting remain intact.
 */
export function repairProfileTrailingBlocks(content, profile, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const base = resultBase(source);
  if (!profile || !Array.isArray(profile.blocks) || !profile.blocks.length) return base;

  const protectedRanges = findProtectedRanges(source);
  const structuralRanges = mergeRanges([...protectedRanges, ...findHtmlCommentRanges(source)]);
  const pair = findBodyPair(source, profile, protectedRanges, structuralRanges);
  if (pair.error) {
    if (pair.bodyStart || pair.bodyClose) {
      base.warnings.push('正文边界不完整，无法确认正文外结构块归属；已保留原文。');
    }
    return base;
  }
  const bodyBodyStart = pair.bodyStart.index + pair.bodyStart[0].length;
  const bodyBodyEnd = pair.bodyClose.index;
  const externalStart = pair.bodyClose.index + pair.bodyClose[0].length;
  const externalEnd = source.length;

  const bodyParse = parseProfileBlocks(source, structuralRanges, profile, bodyBodyStart, bodyBodyEnd);
  const bodyTargets = classifyTopLevel(source, bodyParse, profile).top;
  if (bodyTargets.length) {
    base.warnings.push(options.boundaryEnabled === false
      ? `检测到目标结构块仍在正文结束分隔符（${profile.body.close}）之前；未启用“修复正文边界”时不会移动正文边界，已跳过结构块排序。`
      : `检测到目标结构块仍在正文结束分隔符（${profile.body.close}）之前，正文边界未安全修复；已跳过结构块排序。`);
    return base;
  }

  let workingSource = source;
  let workingRanges = structuralRanges;
  let parse = parseProfileBlocks(workingSource, workingRanges, profile, externalStart, externalEnd);
  if (!healthOf(parse)) {
    if (!parse.unclosed.length) {
      base.warnings.push('正文外结构层级不明确（存在错配结束标记等）；已保留原文，未排序。');
      return base;
    }
    const repaired = tryRepairMissingClose(
      workingSource, workingRanges, profile, parse, externalStart, externalEnd,
    );
    if (!repaired.ok) {
      base.warnings.push(repaired.reason === 'trailing-prose'
        ? '正文外结构块存在未闭合块，且末尾文字归属不明确；已保留原文，未补闭合或排序。'
        : '正文外结构块存在未闭合或歧义结构，且无法明确判断缺失结束标记的归属；已保留原文，未排序或补闭合。');
      return base;
    }
    workingSource = repaired.source;
    workingRanges = repaired.ranges;
    parse = repaired.parse;
    base.repairs.push(...repaired.repairs);
  }

  const classified = classifyTopLevel(workingSource, parse, profile);
  const targetNodes = classified.top;
  if (classified.ambiguous.length) {
    base.warnings.push('检测到同时匹配多个结构块身份或标题歧义的顶层块；已保留原文，未排序。');
    return base;
  }
  const seen = new Set();
  for (const item of targetNodes) {
    if (seen.has(item.identity.id)) {
      base.warnings.push('检测到重复的同一目标结构块，目标不唯一；已保留原文，未排序。');
      return base;
    }
    seen.add(item.identity.id);
  }
  if (targetNodes.length <= 1) {
    if (targetNodes.length === 1 && parse.nodes.some(node => node.closeStart && !node.parent &&
      node.kind === 'html' && !classifyBlock(workingSource, node, profile).identity)) {
      base.warnings.push('只识别到一个目标结构块，其余顶层块的标题或身份无法识别；已保留原文，未排序。');
    }
    if (base.repairs.length) {
      base.content = workingSource;
      base.changed = true;
    }
    return base;
  }

  const ordered = targetNodes.slice().sort((left, right) => {
    const leftIndex = profile.blocks.findIndex(block => block.id === left.identity.id);
    const rightIndex = profile.blocks.findIndex(block => block.id === right.identity.id);
    return leftIndex - rightIndex;
  });
  const slots = targetNodes.slice().sort((left, right) => left.node.openStart - right.node.openStart);
  const sameOrder = slots.every((slot, index) => slot.identity.id === ordered[index].identity.id);
  if (sameOrder) {
    if (base.repairs.length) {
      base.content = workingSource;
      base.changed = true;
    }
    return base;
  }

  let repaired = '';
  let cursor = 0;
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index].node;
    const sourceNode = ordered[index].node;
    repaired += workingSource.slice(cursor, slot.openStart);
    repaired += workingSource.slice(sourceNode.openStart, sourceNode.closeEnd);
    cursor = slot.closeEnd;
  }
  repaired += workingSource.slice(cursor);
  base.content = repaired;
  base.changed = true;
  base.repairs.push('reordered-blocks');
  return base;
}

/**
 * One shared structure pass: body/time boundary first, then trailing blocks.
 * No second pass with hard-coded legacy tags occurs after a profile is chosen.
 */
export function repairWithProfile(content, profile, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  let current = source;
  const warnings = [];
  const repairs = [];
  let boundary = null;
  let trailing = null;
  let calendarResult = options.calendarResult || null;

  if (options.bodyBoundaryEnabled) {
    boundary = repairProfileBodyBoundary(current, profile, options);
    if (boundary.warnings.length) warnings.push(...boundary.warnings);
    if (boundary.changed) {
      current = boundary.content;
      repairs.push(...boundary.repairs);
    }
    if (boundary.calendar) {
      calendarResult = {
        ...(calendarResult || {}),
        ok: true,
        calendar: boundary.calendar,
        source: boundary.source || calendarResult?.source,
        sourceLabel: boundary.sourceLabel || calendarResult?.sourceLabel,
      };
    }
  }

  if (options.trailingOrderEnabled) {
    trailing = repairProfileTrailingBlocks(current, profile, {
      boundaryEnabled: options.bodyBoundaryEnabled === true,
    });
    if (trailing.warnings.length) warnings.push(...trailing.warnings);
    if (trailing.changed) {
      current = trailing.content;
      repairs.push(...trailing.repairs);
    }
  }

  return {
    content: current,
    changed: current !== source,
    warnings: uniqueWarnings(warnings),
    repairs,
    boundary,
    trailing,
    calendarResult,
  };
}

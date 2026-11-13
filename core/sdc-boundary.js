// 纯 SDC / <content> 边界修复。
// 只处理带 SDC 标记的正文；结构不明确时只警告、不破坏原文。
// 结束注释一旦存在即原字节保留，绝不重算它的 date/weekday/time。
import {
  advanceCalendarTime,
  formatDateText,
  formatTimeText,
  formatWeekday,
  parseDateText,
  parseTimeText,
  parseWeekday,
  DEFAULT_ADVANCE_MINUTES,
  MAX_ADVANCE_MINUTES,
} from './calendar-engine.js';
import {
  findHtmlCommentRanges,
  findMatchesOutsideRanges,
  findProtectedRanges,
  mergeRanges,
  removeRanges,
} from './text-scan.js';

const SDC_START_RE = /<!--\s*SDC-start\b([\s\S]*?)-->/gi;
const SDC_END_RE = /<!--\s*SDC-end\b([\s\S]*?)-->/gi;
const CONTENT_START_RE = /<content\b[^>]*>/gi;
const CONTENT_END_RE = /<\/content\s*>/gi;
const AUX_BOUNDARY_RE = /<(?:版权水印|details)(?=[\s>/])/gi;

function parseMarkerFields(inner) {
  const fields = {};
  for (const part of String(inner ?? '').split(/[|｜]/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[=:：]\s*([\s\S]*?)\s*$/.exec(part);
    if (!match) continue;
    fields[match[1].toLowerCase()] = match[2].trim();
  }
  return fields;
}

export function parseSdcMarkerText(markerText) {
  const outer = /<!--\s*SDC-(start|end)\b([\s\S]*?)-->/i.exec(String(markerText ?? ''));
  if (!outer) return null;
  return { edge: outer[1].toLowerCase(), fields: parseMarkerFields(outer[2]), inner: outer[2] };
}

function findBoundary(text, from, ranges) {
  const matches = findMatchesOutsideRanges(text, AUX_BOUNDARY_RE, ranges)
    .filter(match => match.index >= from);
  if (!matches.length) return null;
  const marker = matches[0];
  const before = text.slice(0, marker.index);
  // 分隔线必须紧贴在水印/details 之前，才视为同一段外部辅助内容。
  const separator = /(^|\r?\n)[ \t]*-{3,}[ \t]*(?:\r?\n[ \t]*)$/.exec(before);
  if (separator) {
    return { index: separator.index + separator[1].length, markerIndex: marker.index, marker: marker[0], hasSeparator: true };
  }
  return { index: marker.index, markerIndex: marker.index, marker: marker[0], hasSeparator: false };
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

function synthesisError(source, message) {
  return `未能合成 SDC-end：${message} 请手动补全结束注释的 date/weekday/time，或检查历法来源；未伪造结束日期。`;
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

/**
 * 尝试根据 SDC-start 的 date/weekday/time + 历法推进分钟，生成结束注释。
 * @returns {{ok:boolean,text?:string,error?:string,advanced?:Object}}
 */
export function synthesizeSdcEnd(startMarkerText, calendar, advanceMinutes = DEFAULT_ADVANCE_MINUTES) {
  if (!calendar) return { ok: false, error: '历法来源不可用' };
  const marker = parseSdcMarkerText(startMarkerText);
  if (!marker || marker.edge !== 'start') return { ok: false, error: '缺少 SDC-start' };
  const dateText = marker.fields.date;
  const weekdayText = marker.fields.weekday ?? marker.fields['星期'];
  const timeText = marker.fields.time;
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
    ? advanceMinutes
    : calendar.advanceMinutes;
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

/**
 * 修复 SDC content 边界。
 * @param {string} content
 * @param {{calendar?:Object|null, calendarResult?:Object|null, advanceMinutes?:number, source?:string}} options
 */
export function repairSdcContent(content, options = {}) {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const resultBase = {
    content: source,
    changed: false,
    warnings: [],
    repairs: [],
    source: options.calendarResult?.source ?? options.source ?? null,
    sourceLabel: options.calendarResult?.sourceLabel ?? null,
    calendar: options.calendar ?? options.calendarResult?.calendar ?? null,
  };
  if (!source) return resultBase;

  const ranges = findProtectedRanges(source);
  // 结构化标签/辅助边界要忽略 HTML 注释中的示例；但 SDC-start/end 本身也是注释，
  // 必须继续只按代码保护区域扫描，不能被注释排除规则隐藏。
  const structuralRanges = mergeRanges([...ranges, ...findHtmlCommentRanges(source)]);
  const starts = findMatchesOutsideRanges(source, SDC_START_RE, ranges);
  const ends = findMatchesOutsideRanges(source, SDC_END_RE, ranges);
  const contentStarts = findMatchesOutsideRanges(source, CONTENT_START_RE, structuralRanges);
  const contentEnds = findMatchesOutsideRanges(source, CONTENT_END_RE, structuralRanges);

  if (!starts.length && !ends.length) {
    // 普通回复：没有 SDC 标记时完全不介入。
    return resultBase;
  }
  if (starts.length > 1 || ends.length > 1) {
    resultBase.warnings.push('检测到重复的 SDC-start / SDC-end 标记，边界不明确；已保留原文。');
    return resultBase;
  }
  if (!starts.length) {
    resultBase.warnings.push('只发现 SDC-end 而没有 SDC-start；不会凭空发明起始标记与日期，已保留原文。');
    return resultBase;
  }
  if (!contentStarts.length) {
    resultBase.warnings.push('发现 SDC 标记但缺少 <content> 起始标签；不会猜测正文范围，已保留原文。');
    return resultBase;
  }
  if (contentStarts.length > 1) {
    resultBase.warnings.push('检测到多个 <content> 起始标签，正文范围不明确；已保留原文。');
    return resultBase;
  }
  if (contentEnds.length > 1) {
    resultBase.warnings.push('检测到多个 </content> 结束标签，正文范围不明确；已保留原文。');
    return resultBase;
  }

  const start = starts[0];
  const end = ends[0] || null;
  const close = contentEnds[0] || null;
  const contentStart = contentStarts[0];
  if (contentStart.index >= start.index) {
    resultBase.warnings.push('SDC-start 出现在 <content> 起始标签之前，结构不明确；已保留原文。');
    return resultBase;
  }
  if (end && end.index < start.index + start[0].length) {
    resultBase.warnings.push('SDC-end 出现在 SDC-start 之前或内部，结构不明确；已保留原文。');
    return resultBase;
  }
  if (close && close.index < contentStart.index + contentStart[0].length) {
    resultBase.warnings.push('</content> 出现在正文起始标签内部之前，结构不明确；已保留原文。');
    return resultBase;
  }

  const bodyStart = start.index + start[0].length;
  const boundary = findBoundary(source, bodyStart, structuralRanges);
  const regionEnd = boundary ? boundary.index : source.length;
  const endInside = end && end.index >= bodyStart && end.index <= regionEnd;
  const closeInside = close && close.index >= bodyStart && close.index <= regionEnd;
  // 用户明确要求：SDC-end 必须紧贴 </content>，两者之间只能有空白/换行；
  // 且 </content> 之后到辅助边界之前也不能再夹正文，否则说明标记被提前放置。
  const endToClose = end && close && end.index < close.index
    ? source.slice(end.index + end[0].length, close.index)
    : null;
  const closeToBoundary = close ? source.slice(close.index + close[0].length, regionEnd) : null;
  const alreadyCorrect = !!end && !!close && endInside && closeInside && end.index < close.index &&
    /^\s*$/.test(endToClose) && /^\s*$/.test(closeToBoundary);
  if (alreadyCorrect) return resultBase;

  // 已存在结束注释时原字节搬运；不存在时才尝试合成。
  let endText = end ? end[0] : null;
  let synthesized = false;
  const warnings = resultBase.warnings;
  if (!endText) {
    // 只有“缺少 SDC-end”才需要历法；普通回复、移动既有标记都不应因历法缺失而警告。
    const calendarInfo = resolveCalendarOnDemand(options);
    const calendar = calendarInfo?.calendar;
    if (!calendarInfo?.ok || !calendar) {
      warnings.push(synthesisError(source, calendarInfo?.error || '没有可用的历法来源（请检查所选历法）'));
      return resultBase;
    }
    const advanceMinutes = calendarInfo.source === 'custom' && calendar.advanceMinutesExplicit
      ? calendar.advanceMinutes
      : options.advanceMinutes;
    const synth = synthesizeSdcEnd(start[0], calendar, advanceMinutes);
    if (!synth.ok) {
      warnings.push(synthesisError(source, synth.error));
      return resultBase;
    }
    endText = synth.text;
    synthesized = true;
    resultBase.calendar = calendar;
    resultBase.source = calendarInfo.source ?? resultBase.source;
    resultBase.sourceLabel = calendarInfo.sourceLabel ?? resultBase.sourceLabel;
  }

  const closeText = close ? close[0] : '</content>';
  const removals = [];
  if (end) removals.push({ start: end.index, end: end.index + end[0].length });
  if (close) removals.push({ start: close.index, end: close.index + close[0].length });

  const narrative = source.slice(bodyStart, regionEnd);
  const narrativeRanges = removals
    .filter(range => range.end > bodyStart && range.start < regionEnd)
    .map(range => ({ start: Math.max(range.start, bodyStart) - bodyStart, end: Math.min(range.end, regionEnd) - bodyStart }));
  const narrativeClean = removeRanges(narrative, narrativeRanges, { trimLines: true });

  const afterBoundary = source.slice(regionEnd);
  const afterRanges = removals
    .filter(range => range.end > regionEnd)
    .map(range => ({ start: Math.max(range.start, regionEnd) - regionEnd, end: range.end - regionEnd }));
  const afterClean = removeRanges(afterBoundary, afterRanges, { trimLines: true });

  const tokenBlock = buildTokenBlock(narrativeClean, endText, closeText, !!boundary);
  const repaired = source.slice(0, bodyStart) + tokenBlock + (boundary ? afterClean : '');
  if (repaired === source) return resultBase;

  const repairs = [];
  if (end) repairs.push('moved-end');
  else repairs.push('synthesized-end');
  if (close) repairs.push('moved-close');
  else repairs.push('added-close');
  return {
    ...resultBase,
    content: repaired,
    changed: true,
    repairs,
    synthesizedEnd: synthesized,
  };
}

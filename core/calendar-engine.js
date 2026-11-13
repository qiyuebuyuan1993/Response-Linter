// 纯历法/日期推进模块。
// 只读 ST-SevenDaysCal 的聊天元数据形状，不导入、不执行其模块，不写它的数据。
// 所有计算均为整数运算，不使用本地时区 JS Date。

export const DEFAULT_ADVANCE_MINUTES = 10;
export const MAX_ADVANCE_MINUTES = 10080; // 7 天，足够跨日/月/年且避免异常配置
export const CALENDAR_SOURCE_LABELS = Object.freeze({
  gouhua: '构画 / 当前聊天',
  'four-seasons-28': '四季 28 日预设',
  custom: '自定义 JSON',
});

const STANDARD_WEEKDAY_LABELS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
const STANDARD_WEEKDAY_INDEX = Object.freeze({ 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 });
const ENGLISH_WEEKDAYS = Object.freeze({
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
});
const GREGORIAN_MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

export const FOUR_SEASONS_28 = Object.freeze({
  kind: 'custom',
  id: 'four-seasons-28',
  revision: 1,
  weekdayCycle: 7,
  era: '',
  displayStyle: 'numeric',
  months: Object.freeze(['春', '夏', '秋', '冬'].map(name => Object.freeze({ name, days: 28 }))),
  weekdayLabels: STANDARD_WEEKDAY_LABELS,
  dateFormat: '{year}年{month}{day}日',
  advanceMinutes: DEFAULT_ADVANCE_MINUTES,
  source: 'four-seasons-28',
  sourceLabel: CALENDAR_SOURCE_LABELS['four-seasons-28'],
});
export const DEFAULT_GREGORIAN_CALENDAR = Object.freeze({
  kind: 'gregorian',
  id: 'default-gregorian',
  revision: 1,
  weekdayCycle: 7,
  era: '',
  displayStyle: 'numeric',
  months: Object.freeze(GREGORIAN_MONTH_DAYS.map((days, index) => Object.freeze({ name: `${index + 1}月`, days }))),
  weekdayLabels: STANDARD_WEEKDAY_LABELS,
  dateFormat: '{year}年{month}{day}日',
  advanceMinutes: DEFAULT_ADVANCE_MINUTES,
  source: 'gregorian',
  sourceLabel: '公历',
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasForbiddenKey(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12 || value == null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (hasForbiddenKey(value[key], depth + 1, seen)) return true;
  }
  return false;
}

function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function buildCalendar(raw, { source = 'custom', sourceLabel = '', defaultKind = 'custom' } = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: '历法配置必须是一个 JSON 对象。' };
  if (hasForbiddenKey(raw)) return { ok: false, error: '历法配置包含不允许的属性名。' };

  const hasLeapConfig = object => Object.keys(object || {}).some(key =>
    /^(leap|intercalary)/i.test(key) && object[key] != null && object[key] !== false && object[key] !== '');
  if (hasLeapConfig(raw)) {
    return { ok: false, error: '暂不支持显式闰月/闰日/闰年规则；请改用固定每月天数，或使用支持闰年的标准公历。' };
  }

  const kind = raw.kind == null ? defaultKind : String(raw.kind).trim().toLowerCase();
  if (kind !== 'custom' && kind !== 'gregorian') {
    return { ok: false, error: `未知历法类型「${String(raw.kind)}」，仅支持自定义历法或标准公历。` };
  }

  const monthsInput = raw.months;
  if (!Array.isArray(monthsInput) || monthsInput.length === 0) {
    return { ok: false, error: '历法至少需要一个月份。' };
  }
  if (monthsInput.length > 60) return { ok: false, error: '月份数量不能超过 60。' };
  if (kind === 'gregorian' && monthsInput.length !== 12) {
    return { ok: false, error: '标准公历必须提供 12 个月；否则请使用自定义历法并显式配置每月天数。' };
  }

  const months = [];
  const seenNames = new Set();
  let totalDays = 0;
  for (let index = 0; index < monthsInput.length; index++) {
    const item = monthsInput[index];
    if (!isPlainObject(item)) return { ok: false, error: `第 ${index + 1} 个月份必须是对象。` };
    const hasMonthLeapConfig = Object.keys(item).some(key =>
      /^(leap|intercalary)/i.test(key) && item[key] != null && item[key] !== false && item[key] !== '');
    if (hasMonthLeapConfig) {
      return { ok: false, error: '暂不支持显式闰月配置；请改用固定月份或标准公历。' };
    }
    const name = cleanString(item.name, 12);
    if (!name) return { ok: false, error: `第 ${index + 1} 个月份缺少名称。` };
    if (seenNames.has(name)) return { ok: false, error: `月份名称重复：「${name}」。` };
    seenNames.add(name);
    const days = Number(item.days);
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      return { ok: false, error: `月份「${name}」的天数必须是 1–60 的整数。` };
    }
    totalDays += days;
    months.push({ name, days });
  }
  if (totalDays > 2000) return { ok: false, error: '全年总天数不能超过 2000。' };

  const displayStyle = raw.displayStyle == null ? 'numeric' : String(raw.displayStyle).trim();
  if (displayStyle === 'classical') {
    return { ok: false, error: '暂不支持古典中文数字日期；请使用阿拉伯数字日期（numeric 样式）。' };
  }
  if (displayStyle !== 'numeric') {
    return { ok: false, error: `未知日期样式「${displayStyle}」，仅支持 numeric。` };
  }

  const era = cleanString(raw.era, 24);

  const weekdayInput = Array.isArray(raw.weekdayLabels)
    ? raw.weekdayLabels
    : (Array.isArray(raw.weekdays) ? raw.weekdays : null);
  let weekdayLabels;
  if (weekdayInput) {
    if (weekdayInput.length < 2 || weekdayInput.length > 30) {
      return { ok: false, error: '星期标签数量必须在 2–30 之间。' };
    }
    weekdayLabels = [];
    const seen = new Set();
    for (const label of weekdayInput) {
      const clean = cleanString(label, 8);
      if (!clean) return { ok: false, error: '星期标签不能为空。' };
      if (seen.has(clean)) return { ok: false, error: `星期标签重复：「${clean}」。` };
      seen.add(clean);
      weekdayLabels.push(clean);
    }
  } else {
    weekdayLabels = [...STANDARD_WEEKDAY_LABELS];
  }

  const weekdayCycleRaw = raw.weekdayCycle == null ? weekdayLabels.length : Number(raw.weekdayCycle);
  if (!Number.isInteger(weekdayCycleRaw) || weekdayCycleRaw < 2 || weekdayCycleRaw > 30) {
    return { ok: false, error: '星期循环长度必须是 2–30 的整数。' };
  }
  if (weekdayCycleRaw !== weekdayLabels.length) {
    return { ok: false, error: '星期循环长度必须与显式提供的星期名称数量一致。' };
  }
  if (!weekdayInput && weekdayCycleRaw !== 7) {
    return { ok: false, error: '非 7 日星期循环必须显式提供星期名称，不能猜测。' };
  }

  const dateFormat = raw.dateFormat == null ? '{year}年{month}{day}日' : String(raw.dateFormat).trim().slice(0, 80);
  if (!dateFormat || !/\{year\}/.test(dateFormat) || !/\{month\}/.test(dateFormat) || !/\{day\}/.test(dateFormat)) {
    return { ok: false, error: 'dateFormat 必须包含 {year}、{month} 和 {day}。' };
  }
  const placeholders = dateFormat.match(/\{[^}]+\}/g) || [];
  const allowed = new Set(['{year}', '{month}', '{day}', '{era}']);
  const unknown = placeholders.find(token => !allowed.has(token));
  if (unknown) return { ok: false, error: `dateFormat 包含未知占位符 ${unknown}。` };
  for (const token of ['{year}', '{month}', '{day}', '{era}']) {
    if (placeholders.filter(item => item === token).length > 1) {
      return { ok: false, error: `dateFormat 中 ${token} 不能重复出现，否则无法确定日期位置。` };
    }
  }

  const advanceMinutesExplicit = raw.advanceMinutes != null;
  const advanceMinutesRaw = advanceMinutesExplicit ? Number(raw.advanceMinutes) : DEFAULT_ADVANCE_MINUTES;
  if (!Number.isInteger(advanceMinutesRaw) || advanceMinutesRaw < 1 || advanceMinutesRaw > MAX_ADVANCE_MINUTES) {
    return { ok: false, error: `推进分钟必须是 1–${MAX_ADVANCE_MINUTES} 的整数。` };
  }

  const epoch = {};
  for (const key of ['epochYear', 'epochOrdinal', 'epochWeekday']) {
    if (Number.isInteger(raw[key])) epoch[key] = raw[key];
  }
  if (raw.absoluteCycle === true) epoch.absoluteCycle = true;

  return {
    ok: true,
    calendar: {
      kind,
      id: cleanString(raw.id, 60) || (kind === 'gregorian' ? 'default-gregorian' : 'custom-calendar'),
      revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
      weekdayCycle: weekdayCycleRaw,
      era,
      displayStyle,
      months,
      weekdayLabels,
      dateFormat,
      advanceMinutes: advanceMinutesRaw,
      advanceMinutesExplicit,
      source,
      sourceLabel: sourceLabel || CALENDAR_SOURCE_LABELS[source] || source,
      ...epoch,
    },
  };
}

/**
 * 校验并规范化自定义历法 JSON（对象或字符串）。
 */
export function parseCustomCalendarConfig(input) {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > 20000) return { ok: false, error: '历法 JSON 过长（最多 20000 字符）。' };
    try { value = JSON.parse(input); }
    catch (error) { return { ok: false, error: `JSON 解析失败：${error.message}` }; }
  }
  if (!isPlainObject(value)) return { ok: false, error: '自定义历法必须是一个 JSON 对象。' };
  return buildCalendar(value, { source: 'custom', sourceLabel: CALENDAR_SOURCE_LABELS.custom, defaultKind: 'custom' });
}

export function validateCalendarDescriptor(raw) {
  return buildCalendar(raw, { source: 'gouhua', sourceLabel: CALENDAR_SOURCE_LABELS.gouhua, defaultKind: 'custom' });
}

/**
 * 只读解析 ST-SevenDaysCal 当前聊天里的 caldesc-user（直接描述符，不是 raw 包装）。
 * 不创建 sp-store，不写 chatMetadata，不做静默猜测回退。
 */
export function readGouhuaCalendar(ctx) {
  const descriptor = ctx?.chatMetadata?.['sp-store']?.data?.['caldesc-user'];
  const base = { source: 'gouhua', sourceLabel: CALENDAR_SOURCE_LABELS.gouhua };
  if (!descriptor) {
    return {
      ...base,
      ok: false,
      error: '当前聊天没有构画历法描述符（sp-store.data["caldesc-user"]）。请先在构画中设置历法，或改选四季预设 / 自定义 JSON。',
    };
  }
  if (!isPlainObject(descriptor)) {
    return { ...base, ok: false, error: '构画历法描述符不是对象，已拒绝猜测。' };
  }
  const result = buildCalendar(descriptor, { ...base, defaultKind: 'custom' });
  if (!result.ok) return { ...base, ok: false, error: `构画历法描述符无效：${result.error}` };
  return { ...base, ok: true, calendar: result.calendar };
}

/**
 * 每次修复都重新解析来源；聊天切换/构画修改历法会在下一次修复立即生效。
 */
export function resolveCalendarSource({ source = 'gouhua', customJson = '', ctx = null } = {}) {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (normalized === 'gouhua' || normalized === 'current-chat' || normalized === 'currentchat') {
    return readGouhuaCalendar(ctx);
  }
  if (normalized === 'four-seasons-28' || normalized === 'four-seasons' || normalized === 'fourseasons28') {
    return { ok: true, source: 'four-seasons-28', sourceLabel: CALENDAR_SOURCE_LABELS['four-seasons-28'], calendar: { ...FOUR_SEASONS_28 } };
  }
  if (normalized === 'custom') {
    const result = parseCustomCalendarConfig(customJson);
    if (!result.ok) {
      return { ok: false, source: 'custom', sourceLabel: CALENDAR_SOURCE_LABELS.custom, error: result.error };
    }
    return { ok: true, source: 'custom', sourceLabel: CALENDAR_SOURCE_LABELS.custom, calendar: result.calendar };
  }
  return { ok: false, source: normalized || 'unknown', sourceLabel: '未知来源', error: `未知历法来源「${String(source)}」。` };
}

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(calendar, year, month) {
  if (!calendar || !Array.isArray(calendar.months)) return null;
  if (!Number.isInteger(month) || month < 1 || month > calendar.months.length) return null;
  if (calendar.kind === 'gregorian' && calendar.months.length === 12) {
    return month === 2 && isLeapYear(year) ? 29 : GREGORIAN_MONTH_DAYS[month - 1];
  }
  return calendar.months[month - 1].days;
}

export function validateDateParts(calendar, date) {
  if (!calendar || !date) return false;
  const year = Number(date.year);
  const month = Number(date.month);
  const day = Number(date.day);
  if (!Number.isInteger(year) || year < 0 || year > 999999) return false;
  if (!Number.isInteger(month) || month < 1 || month > calendar.months.length) return false;
  const maxDay = daysInMonth(calendar, year, month);
  return Number.isInteger(day) && day >= 1 && day <= maxDay;
}

function monthNameMap(calendar) {
  const map = new Map();
  calendar.months.forEach((month, index) => map.set(month.name, index + 1));
  return map;
}

function monthNamePattern(calendar) {
  return [...calendar.months]
    .map(month => month.name)
    .sort((a, b) => b.length - a.length)
    .map(name => escapeRegExp(name))
    .join('|');
}

function compileDateFormat(calendar) {
  const literal = part => escapeRegExp(part).replace(/\s+/g, '\\s*');
  let pattern = '^\\s*';
  if (!calendar.dateFormat.includes('{era}') && calendar.era) {
    pattern += `(?:${escapeRegExp(calendar.era)}\\s*)?`;
  }
  const tokens = calendar.dateFormat.split(/(\{year\}|\{month\}|\{day\}|\{era\})/).filter(Boolean);
  for (const token of tokens) {
    if (token === '{year}') pattern += '(?<year>\\d{1,7})';
    else if (token === '{month}') pattern += `(?<month>${monthNamePattern(calendar)})`;
    else if (token === '{day}') pattern += '(?<day>\\d{1,3})';
    else if (token === '{era}') pattern += calendar.era ? escapeRegExp(calendar.era) : '(?<era>)';
    else pattern += literal(token);
  }
  pattern += '\\s*$';
  try { return new RegExp(pattern); } catch { return null; }
}

/**
 * 解析 Arabic 年/日 + 当前历法月名。月份名会被正则转义；中文数字日期明确拒绝。
 */
export function parseDateText(text, calendar) {
  if (!calendar || !Array.isArray(calendar.months) || !calendar.months.length) return null;
  const source = String(text ?? '').trim();
  if (!source || !/[\d]/.test(source)) return null;

  const formatRegex = compileDateFormat(calendar);
  const formatMatch = formatRegex ? formatRegex.exec(source) : null;
  if (formatMatch?.groups?.year && formatMatch.groups?.month && formatMatch.groups?.day) {
    const month = monthNameMap(calendar).get(formatMatch.groups.month);
    return validateDateParts(calendar, {
      year: Number(formatMatch.groups.year),
      month,
      day: Number(formatMatch.groups.day),
    }) ? { year: Number(formatMatch.groups.year), month, day: Number(formatMatch.groups.day) } : null;
  }

  const names = monthNamePattern(calendar);
  const eraPrefix = calendar.era ? `(?:${escapeRegExp(calendar.era)}\\s*)?` : '';
  const generic = new RegExp(`^\\s*${eraPrefix}(\\d{1,7})\\s*年?\\s*(?:[-/.]\\s*)?(${names})\\s*(?:[-/.]\\s*)?(\\d{1,3})\\s*日?\\s*$`);
  const genericMatch = generic.exec(source);
  if (genericMatch) {
    const month = monthNameMap(calendar).get(genericMatch[2]);
    const date = { year: Number(genericMatch[1]), month, day: Number(genericMatch[3]) };
    return validateDateParts(calendar, date) ? date : null;
  }

  if (calendar.kind === 'gregorian') {
    const numeric = /^\s*(\d{1,7})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*$/.exec(source);
    if (numeric) {
      const date = { year: Number(numeric[1]), month: Number(numeric[2]), day: Number(numeric[3]) };
      return validateDateParts(calendar, date) ? date : null;
    }
  }
  return null;
}

export function formatDateText(calendar, date) {
  if (!calendar || !date) return null;
  const month = calendar.months[date.month - 1];
  if (!month) return null;
  const values = {
    year: String(date.year),
    month: month.name,
    day: String(date.day),
    era: String(calendar.era || ''),
  };
  let out = calendar.dateFormat.replace(/\{(year|month|day|era)\}/g, (_, key) => values[key]);
  if (calendar.era && !calendar.dateFormat.includes('{era}')) out = `${calendar.era}${out}`;
  return out;
}

function isStandardWeekdayLabels(labels) {
  return Array.isArray(labels) && labels.length === 7 && labels.every((label, index) => label === STANDARD_WEEKDAY_LABELS[index]);
}

export function parseWeekday(text, calendar) {
  if (!calendar || !Array.isArray(calendar.weekdayLabels)) return null;
  const labels = calendar.weekdayLabels;
  const source = String(text ?? '').trim();
  if (!source) return null;

  const exact = labels.findIndex(label => label === source);
  if (exact >= 0) return exact;

  if (isStandardWeekdayLabels(labels)) {
    const chinese = /(?:周|週|星期|礼拜|禮拜)\s*([一二三四五六日天])/.exec(source);
    if (chinese) {
      const index = STANDARD_WEEKDAY_INDEX[chinese[1]];
      return Number.isInteger(index) && index < labels.length ? index : null;
    }
    const english = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(source);
    if (english) {
      const index = ENGLISH_WEEKDAYS[english[1].toLowerCase()];
      return Number.isInteger(index) ? index : null;
    }
  }
  return null;
}

export function formatWeekday(calendar, index) {
  if (!calendar || !Array.isArray(calendar.weekdayLabels)) return null;
  const count = calendar.weekdayLabels.length;
  if (!Number.isInteger(index) || count === 0) return null;
  const normalized = ((index % count) + count) % count;
  return calendar.weekdayLabels[normalized];
}

export function parseTimeText(text) {
  const source = String(text ?? '').trim();
  const match = /^(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?$/.exec(source);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? null : Number(match[3]);
  if (hour > 23 || minute > 59 || (second != null && second > 59)) return null;
  return { hour, minute, second };
}

export function formatTimeText(time) {
  if (!time || !Number.isInteger(time.hour) || !Number.isInteger(time.minute)) return null;
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

function gregorianToJdn(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function jdnToGregorian(jdn) {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor(146097 * b / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor(1461 * d / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

export function addDaysToDate(calendar, date, dayDelta) {
  if (!validateDateParts(calendar, date) || !Number.isInteger(dayDelta)) return null;
  if (calendar.kind === 'gregorian') {
    const jdn = gregorianToJdn(Number(date.year), Number(date.month), Number(date.day)) + dayDelta;
    const next = jdnToGregorian(jdn);
    return validateDateParts(calendar, next) ? next : null;
  }
  const yearLength = calendar.months.reduce((sum, month) => sum + month.days, 0);
  let dayOfYear = Number(date.day);
  for (let index = 0; index < Number(date.month) - 1; index++) dayOfYear += calendar.months[index].days;
  const absolute = Number(date.year) * yearLength + dayOfYear - 1 + dayDelta;
  const year = Math.floor(absolute / yearLength);
  const remainder = ((absolute % yearLength) + yearLength) % yearLength;
  let month = 1;
  let day = remainder + 1;
  for (let index = 0; index < calendar.months.length; index++) {
    if (day <= calendar.months[index].days) { month = index + 1; break; }
    day -= calendar.months[index].days;
  }
  const next = { year, month, day };
  return validateDateParts(calendar, next) ? next : null;
}

/**
 * 推进分钟并把日期、星期一起推进。例：1年冬28日 周日 23:50 + 10 分
 * → 2年春1日 周一 00:00（四季 28 日历法）。
 */
export function advanceCalendarTime({ calendar, date, weekdayIndex, time, advanceMinutes = DEFAULT_ADVANCE_MINUTES }) {
  if (!calendar || !validateDateParts(calendar, date) || !parseTimeText(formatTimeText(time) || '')) {
    return { ok: false, error: '起始日期或时间不完整，无法推进。' };
  }
  if (!Number.isInteger(weekdayIndex) || weekdayIndex < 0 || weekdayIndex >= calendar.weekdayLabels.length) {
    return { ok: false, error: '起始星期无法解析，不能猜测推进后的星期。' };
  }
  if (!Number.isInteger(advanceMinutes) || advanceMinutes < 1 || advanceMinutes > MAX_ADVANCE_MINUTES) {
    return { ok: false, error: `推进分钟必须是 1–${MAX_ADVANCE_MINUTES} 的整数。` };
  }
  const totalMinutes = time.hour * 60 + time.minute + advanceMinutes;
  const dayDelta = Math.floor(totalMinutes / 1440);
  const timeMinutes = totalMinutes % 1440;
  const nextDate = addDaysToDate(calendar, date, dayDelta);
  if (!nextDate) return { ok: false, error: '日期推进越界，已拒绝伪造结束日期。' };
  return {
    ok: true,
    date: nextDate,
    weekdayIndex: (weekdayIndex + dayDelta) % calendar.weekdayLabels.length,
    time: { hour: Math.floor(timeMinutes / 60), minute: timeMinutes % 60 },
    dayDelta,
  };
}

export function describeCalendar(calendar) {
  if (!calendar) return '无可用的历法';
  const monthText = calendar.months.map((month, index) => `${index + 1}=${month.name}(${month.days}天)`).join('、');
  return `${calendar.sourceLabel || calendar.source || ''} · ${calendar.kind} · 一年 ${calendar.months.length} 个月 / ${calendar.months.reduce((sum, month) => sum + month.days, 0)} 天 · ${monthText} · 星期 ${calendar.weekdayLabels.join('、')}`;
}

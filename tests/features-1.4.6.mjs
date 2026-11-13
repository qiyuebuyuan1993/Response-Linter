// Run: node --test tests/*.mjs (Node.js 24) or node tests/features-1.4.6.mjs
// 1.4.6 纯转换 + 手动/自动/预览/撤销/流式/历法来源集成测试。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
globalThis.__testContext = {
  chat: [],
  extensionSettings: {},
  chatMetadata: {},
  streamingProcessor: null,
  saveChat: async () => {},
};
globalThis.getContext = () => globalThis.__testContext;
globalThis.SillyTavern = { getContext };
globalThis.ResponseLinter = {};

const {
  sanitizeLeakedReasoning,
} = await import('../core/reasoning-sanitizer.js');
const {
  repairSdcContent,
  synthesizeSdcEnd,
} = await import('../core/sdc-boundary.js');
const {
  FOUR_SEASONS_28,
  DEFAULT_GREGORIAN_CALENDAR,
  parseCustomCalendarConfig,
  parseDateText,
  parseTimeText,
  resolveCalendarSource,
  advanceCalendarTime,
  formatDateText,
  validateCalendarDescriptor,
} = await import('../core/calendar-engine.js');
const {
  transformContent,
  normalizeRepairSettings,
} = await import('../core/repair-service.js');
const {
  createStructureSettingsExport,
  importStructureSettingsText,
} = await import('../core/settings-transfer.js');
const {
  mergeFeatureSettings,
  readFeatureSettings,
  seedCustomCalendarDraft,
  CUSTOM_CALENDAR_PRESET_JSON,
} = await import('../core/feature-settings.js');
const { UIStateManager } = await import('../presentation/modules/ui-state-manager.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { createBackendController } = await import('../core/backend-controller.js');

const controller = createBackendController('response-linter');
controller.start = () => { controller.isRunning = true; };
fixCoordinator._sleep = async () => {};

const sdcStart = (date, weekday, time) => `<!-- SDC-start | date=${date} | weekday=${weekday} | time=${time} -->`;
const sdcEnd = (date, weekday, time) => `<!-- SDC-end | date=${date} | weekday=${weekday} | time=${time} -->`;
const aux = '<版权水印>water</版权水印>\n---\n<details><summary>设定</summary>keep</details>';

let saves;
const originalFeatureFixtures = [];

function messageFixture(mes, { swipe = mes, extra = {} } = {}) {
  return { mes, is_user: false, swipe_id: 0, swipes: [swipe], extra: { display_text: mes, ...extra } };
}

function waitForEvent(name, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { document.removeEventListener(name, onEvent); reject(new Error(`timeout: ${name}`)); }, timeoutMs);
    const onEvent = event => {
      clearTimeout(timer);
      document.removeEventListener(name, onEvent);
      resolve(event.detail);
    };
    document.addEventListener(name, onEvent);
  });
}

beforeEach(() => {
  assert.equal(fixCoordinator.fixQueue.length, 0);
  fixCoordinator.isProcessing = false;
  fixCoordinator._sleep = async () => {};
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageHandler.lastContent.clear();
  messageHandler.lastHandledAt.clear();
  messageHandler.retryCounts.clear();
  messageHandler.ctxRef = null;
  __testContext.chat = [];
  __testContext.extensionSettings = {};
  __testContext.chatMetadata = {};
  __testContext.streamingProcessor = null;
  __testContext.updateMessageBlock = async id => { await messageHandler._handleMessageRendered(String(id)); };
  __testContext.saveChat = async () => { saves++; };
  saves = 0;
  globalThis.UIState = { rules: [] };
  controller.resetStatistics();
});

test('推理清理删除完整块，保留围栏/行内代码，未闭合块仅在明确锚点时清理', () => {
  const mixed = '<thinking>甲</thinking>\n<think>乙</think>\n<content>正文</content>';
  const cleaned = sanitizeLeakedReasoning(mixed);
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.removedBlocks, 2);
  assert.equal(cleaned.content, '<content>正文</content>');
  assert.equal(sanitizeLeakedReasoning(cleaned.content).changed, false, 'idempotent');

  const fenced = '```html\n<think>示例</think>\n```\n正文 `<thinking>x</thinking>`';
  assert.equal(sanitizeLeakedReasoning(fenced).changed, false);

  const unclosed = '<thinking>泄漏内容\n<content>正文</content>';
  const leak = sanitizeLeakedReasoning(unclosed);
  assert.equal(leak.content, '<content>正文</content>');
  assert.equal(leak.removedLeaks, 1);
  assert.equal(leak.warnings.length, 0);

  const uncertain = '<thinking>无法确定边界';
  const kept = sanitizeLeakedReasoning(uncertain);
  assert.equal(kept.changed, false);
  assert.equal(kept.content, uncertain);
  assert.match(kept.warnings[0], /未闭合/);

  const properlyNested = '<think>外层<thinking>内层</thinking>外层</think>正文';
  const nested = sanitizeLeakedReasoning(properlyNested);
  assert.equal(nested.content, '正文');
  assert.equal(nested.removedBlocks, 1);
  assert.deepEqual(nested.warnings, [], 'properly nested block is safely removed as one outer block');

  const crossed = '<think>左<thinking>内</think>尾</thinking>正文';
  const malformed = sanitizeLeakedReasoning(crossed);
  assert.equal(malformed.changed, false);
  assert.equal(malformed.content, crossed);
  assert.ok(malformed.warnings.some(item => /保留该处原文/.test(item)), 'warning describes retained malformed region');
});

test('正确 SDC 结构零修改，并原样保留异常的既有结束注释', () => {
  const content = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${sdcEnd('乱写日期', '周八', '25:99')}\n</content>\n${aux}`;
  const result = repairSdcContent(content, { calendar: FOUR_SEASONS_28 });
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
  assert.equal(result.warnings.length, 0);
});

test('四季历法跨日/季/年推进结束注释，接受全角冒号', () => {
  const missing = `<content>\n${sdcStart('1年冬28日', '周日', '23：50')}\n正文\n</content>\n${aux}`;
  const result = repairSdcContent(missing, { calendar: FOUR_SEASONS_28, advanceMinutes: 10 });
  assert.equal(result.changed, true);
  assert.equal(result.synthesizedEnd, true);
  assert.ok(result.content.includes(sdcEnd('2年春1日', '周一', '00:00')));
  assert.ok(result.content.indexOf(sdcEnd('2年春1日', '周一', '00:00')) < result.content.indexOf('<版权水印>'));
  assert.ok(result.content.includes('正文'));
  assert.ok(result.content.includes(aux));
});

test('SDC-end 必须紧贴 </content>：反向顺序/夹正文/close 后正文都会搬回，且幂等', () => {
  const weirdEnd = sdcEnd('1年夏5日', '周五', '12:30');
  const reverseFixed = repairSdcContent(`<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>\n${weirdEnd}`, { calendar: FOUR_SEASONS_28 });
  assert.equal(reverseFixed.changed, true);
  assert.ok(reverseFixed.content.indexOf(weirdEnd) < reverseFixed.content.indexOf('</content>'));
  assert.equal(reverseFixed.content.split(weirdEnd).length - 1, 1, 'exact end marker preserved once');
  assert.equal(repairSdcContent(reverseFixed.content, { calendar: FOUR_SEASONS_28 }).changed, false);

  const narrativeBetween = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${weirdEnd}\n仍在正文\n</content>`;
  const narrativeFixed = repairSdcContent(narrativeBetween, { calendar: FOUR_SEASONS_28 });
  assert.equal(narrativeFixed.changed, true);
  assert.ok(narrativeFixed.content.indexOf('仍在正文') < narrativeFixed.content.indexOf(weirdEnd));
  assert.equal(narrativeFixed.content.slice(narrativeFixed.content.indexOf(weirdEnd), narrativeFixed.content.indexOf('</content>')).replace(weirdEnd, '').trim(), '');
  assert.equal(repairSdcContent(narrativeFixed.content, { calendar: FOUR_SEASONS_28 }).changed, false);

  const afterClose = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${weirdEnd}\n</content>\n仍在正文\n<版权水印>water</版权水印>`;
  const afterCloseFixed = repairSdcContent(afterClose, { calendar: FOUR_SEASONS_28 });
  assert.equal(afterCloseFixed.changed, true);
  assert.ok(afterCloseFixed.content.indexOf('仍在正文') < afterCloseFixed.content.indexOf(weirdEnd));
  assert.ok(afterCloseFixed.content.indexOf(weirdEnd) < afterCloseFixed.content.indexOf('</content>'));
  assert.ok(afterCloseFixed.content.indexOf('</content>') < afterCloseFixed.content.indexOf('<版权水印>'));
  assert.equal(repairSdcContent(afterCloseFixed.content, { calendar: FOUR_SEASONS_28 }).changed, false);

  const noAux = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${weirdEnd}\n尾部正文\n</content>`;
  const noAuxFixed = repairSdcContent(noAux, { calendar: FOUR_SEASONS_28 });
  assert.equal(noAuxFixed.changed, true);
  assert.ok(noAuxFixed.content.indexOf('尾部正文') < noAuxFixed.content.indexOf(weirdEnd));
  assert.ok(noAuxFixed.content.indexOf(weirdEnd) < noAuxFixed.content.indexOf('</content>'));

  const already = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${weirdEnd}\n</content>`;
  assert.equal(repairSdcContent(already, { calendar: FOUR_SEASONS_28 }).changed, false);
});

test('错位的结束注释/</content> 搬到最早的水印/details 边界之前，分隔线保持在外', () => {
  const misplaced = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n<版权水印>water</版权水印>\n---\n<details><summary>设定</summary>keep</details>\n${sdcEnd('1年夏5日', '周五', '12:30')}\n</content>`;
  const result = repairSdcContent(misplaced, { calendar: FOUR_SEASONS_28 });
  assert.equal(result.changed, true);
  assert.ok(result.content.includes(sdcEnd('1年夏5日', '周五', '12:30')), 'byte-for-byte end marker kept');
  assert.ok(result.content.indexOf(sdcEnd('1年夏5日', '周五', '12:30')) < result.content.indexOf('<版权水印>'));
  assert.ok(result.content.indexOf('</content>') < result.content.indexOf('<版权水印>'));
  assert.ok(result.content.includes('正文'));
  assert.ok(result.content.includes('<版权水印>water</版权水印>\n---\n<details>'));

  const detailsOnly = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n<details>辅助</details>\n</content>`;
  const second = repairSdcContent(detailsOnly, { calendar: FOUR_SEASONS_28 });
  assert.equal(second.changed, true);
  assert.ok(second.content.indexOf('</content>') < second.content.indexOf('<details>'), 'details stays outside content');
});

test('SDC 缺失起点/重复标记/未知历法/普通回复都安全拒绝或忽略', () => {
  const ordinary = '<content>普通正文</content>';
  assert.equal(repairSdcContent(ordinary, { calendar: FOUR_SEASONS_28 }).changed, false);
  assert.deepEqual(repairSdcContent(ordinary, { calendar: FOUR_SEASONS_28 }).warnings, []);

  const quoted = '```html\n<content>\n<!-- SDC-start | date=1年夏5日 | weekday=周五 | time=12:20 -->\n示例\n</content>\n```';
  assert.equal(repairSdcContent(quoted, { calendar: FOUR_SEASONS_28 }).changed, false);

  const noStart = `<content>\n正文\n${sdcEnd('1年夏5日', '周五', '12:30')}\n</content>`;
  const noStartResult = repairSdcContent(noStart, { calendar: FOUR_SEASONS_28 });
  assert.equal(noStartResult.changed, false);
  assert.match(noStartResult.warnings[0], /SDC-start/);

  const duplicate = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n${sdcStart('1年夏5日', '周五', '12:21')}\n正文\n</content>`;
  const duplicateResult = repairSdcContent(duplicate, { calendar: FOUR_SEASONS_28 });
  assert.equal(duplicateResult.changed, false);
  assert.match(duplicateResult.warnings[0], /重复/);

  const missingCalendar = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>`;
  const noCalendar = repairSdcContent(missingCalendar, { calendar: null });
  assert.equal(noCalendar.changed, false);
  assert.match(noCalendar.warnings[0], /历法|合成/);

  const missingContentStart = `${sdcStart('1年夏5日', '周五', '12:20')}\n正文`;
  const noContent = repairSdcContent(missingContentStart, { calendar: FOUR_SEASONS_28 });
  assert.equal(noContent.changed, false);
  assert.match(noContent.warnings[0], /content/);
});

test('缺失历法只影响“补写 SDC-end”，普通回复/已有结束标记移动不产生无关警告', () => {
  const settings = { repairSdcBoundary: true, sdcCalendarSource: 'gouhua', sdcAdvanceMinutes: 10 };
  const plain = transformContent('<content>普通正文</content>', settings, { chatMetadata: {} });
  assert.equal(plain.changed, false);
  assert.deepEqual(plain.warnings, []);

  const correct = transformContent(`<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${sdcEnd('1年夏5日', '周五', '12:30')}\n</content>`, settings, { chatMetadata: {} });
  assert.equal(correct.changed, false);
  assert.deepEqual(correct.warnings, []);

  const moved = transformContent(`<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>\n${sdcEnd('1年夏5日', '周五', '12:30')}`, settings, { chatMetadata: {} });
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.warnings, []);
  assert.ok(moved.content.indexOf(sdcEnd('1年夏5日', '周五', '12:30')) < moved.content.indexOf('</content>'));

  const missingEnd = transformContent(`<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>`, settings, { chatMetadata: {} });
  assert.equal(missingEnd.changed, false);
  assert.ok(missingEnd.warnings.some(item => /手动补全/.test(item) && /date\/weekday\/time/.test(item)));
});

test('自定义历法支持正则字符月名/有序星期/格式化日期，且校验非法配置', () => {
  const custom = JSON.stringify({
    kind: 'custom',
    era: '天历',
    months: [{ name: 'A+B(夏)', days: 28 }, { name: '秋[末]', days: 28 }],
    weekdayLabels: ['甲日', '乙日', '丙日', '丁日', '戊日', '己日', '庚日'],
    dateFormat: '{year}年{month}{day}日',
    advanceMinutes: 30,
  });
  const parsed = parseCustomCalendarConfig(custom);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parseDateText('天历1年A+B(夏)28日', parsed.calendar), { year: 1, month: 1, day: 28 });
  assert.equal(parseTimeText('12：20').minute, 20);
  const synth = synthesizeSdcEnd(sdcStart('天历1年A+B(夏)28日', '丙日', '23:50'), parsed.calendar, 30);
  assert.equal(synth.ok, true);
  assert.ok(synth.text.includes('天历1年秋[末]1日'));
  assert.ok(synth.text.includes('丁日'));

  const duplicate = parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }, { name: '春', days: 28 }] }));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /重复/);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 0 }] })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ kind: 'unknown', months: [{ name: '春', days: 28 }] })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }], dateFormat: '{year}{month}' })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }], dateFormat: '{year}{month}{day}{evil}' })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }], dateFormat: '{year}{year}{month}{day}' })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }], dateFormat: '{year}{month}{day}', leapRules: [{ month: 2, days: 1 }] })).ok, false);
  assert.equal(parseCustomCalendarConfig(JSON.stringify({ months: [{ name: '春', days: 28 }], advanceMinutes: -1 })).ok, false);
  assert.equal(parseCustomCalendarConfig('{"months":[{"name":"春","days":28}],"__proto__":{"polluted":true}}').ok, false);
  assert.equal({}.polluted, undefined);
});

test('Gregorian 支持闰年；自定义越界/古典中文日期安全失败', () => {
  assert.deepEqual(parseDateText('2024年2月29日', DEFAULT_GREGORIAN_CALENDAR), { year: 2024, month: 2, day: 29 });
  assert.equal(parseDateText('2023年2月29日', DEFAULT_GREGORIAN_CALENDAR), null);
  assert.deepEqual(
    advanceCalendarTime({
      calendar: DEFAULT_GREGORIAN_CALENDAR,
      date: { year: 2024, month: 2, day: 28 },
      weekdayIndex: 2,
      time: { hour: 23, minute: 59 },
      advanceMinutes: 2,
    }).date,
    { year: 2024, month: 2, day: 29 },
  );
  assert.equal(parseDateText('1年夏29日', { ...FOUR_SEASONS_28 }), null);
  assert.equal(parseDateText('元年夏初五日', { ...FOUR_SEASONS_28 }), null);
  const descriptor = validateCalendarDescriptor({
    kind: 'gregorian', weekdayCycle: 7, displayStyle: 'numeric',
    months: Array.from({ length: 12 }, (_, index) => ({ name: `${index + 1}月`, days: index === 1 ? 29 : 31 })),
  });
  assert.equal(descriptor.ok, true);
});

test('构画历法来源每次现读：聊天切换生效，描述符只读不被修改', () => {
  const ctxOne = { chatMetadata: { 'sp-store': { data: { 'caldesc-user': { kind: 'custom', weekdayCycle: 7, months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }] } } } } };
  const ctxTwo = { chatMetadata: { 'sp-store': { data: { 'caldesc-user': { kind: 'custom', weekdayCycle: 7, months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }, { name: '秋', days: 28 }, { name: '冬', days: 28 }] } } } } };
  const snapshotOne = JSON.stringify(ctxOne.chatMetadata);
  const snapshotTwo = JSON.stringify(ctxTwo.chatMetadata);

  const startOne = `<content>\n${sdcStart('1年夏28日', '周日', '23:50')}\n正文\n</content>`;
  const first = transformContent(startOne, { repairSdcBoundary: true, sdcCalendarSource: 'gouhua', sdcAdvanceMinutes: 10 }, ctxOne);
  assert.equal(first.changed, true);
  assert.ok(first.content.includes('2年春1日'));
  assert.equal(JSON.stringify(ctxOne.chatMetadata), snapshotOne, 'source metadata must not be mutated');

  const startTwo = `<content>\n${sdcStart('1年冬28日', '周日', '23:50')}\n正文\n</content>`;
  const second = transformContent(startTwo, { repairSdcBoundary: true, sdcCalendarSource: 'gouhua', sdcAdvanceMinutes: 10 }, ctxTwo);
  assert.equal(second.changed, true);
  assert.ok(second.content.includes('2年春1日'));
  assert.equal(JSON.stringify(ctxTwo.chatMetadata), snapshotTwo);

  const missing = resolveCalendarSource({ source: 'gouhua', ctx: { chatMetadata: {} } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没有构画历法/);

  const invalid = resolveCalendarSource({ source: 'gouhua', ctx: { chatMetadata: { 'sp-store': { data: { 'caldesc-user': { kind: 'custom', months: [] } } } } } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /无效/);
});

test('两个开关独立且默认关闭；无用户规则的手动修复仅走 messageModifier 并保存一次', async () => {
  assert.deepEqual(normalizeRepairSettings({}), {
    removeLeakedReasoning: false,
    repairSdcBoundary: false,
    repairDetailsOrder: false,
    detailsMonologueKeyword: '内心独白',
    detailsChoicesKeyword: '你的选择是',
    calendarSource: 'gouhua',
    customCalendarJson: '',
    advanceMinutes: 10,
    raw: {},
  });
  const source = `<thinking>泄漏</thinking>\n<content>\n${sdcStart('1年冬28日', '周日', '23:50')}\n正文\n</content>\n${aux}`;
  __testContext.chat = [messageFixture(source, { extra: { reasoning: 'host-owned', keep: 1 } })];
  const original = structuredClone(__testContext.chat[0]);
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [],
    removeLeakedReasoning: true, repairSdcBoundary: true,
    sdcCalendarSource: 'four-seasons-28', sdcAdvanceMinutes: 10,
  });

  const result = await controller.triggerManualFix('0');
  assert.equal(result.success, true);
  assert.equal(result.warnings.length, 0);
  const message = __testContext.chat[0];
  assert.ok(!message.mes.includes('<thinking>'));
  assert.ok(message.mes.includes(sdcEnd('2年春1日', '周一', '00:00')));
  assert.ok(message.mes.includes('<版权水印>water</版权水印>'));
  assert.equal(message.extra.reasoning, 'host-owned');
  assert.equal(message.extra.keep, 1);
  assert.equal(message.extra.display_text, message.mes);
  assert.equal(message.swipes[0], message.mes);
  assert.equal(saves, 1);
  assert.equal(controller.canUndoFix('0'), true);

  const undone = await controller.undoFix('0');
  assert.equal(undone.success, true);
  assert.deepEqual(message.mes, original.mes);
  assert.equal(message.extra.display_text, original.extra.display_text);
  assert.equal(message.swipes[0], original.swipes[0]);
  assert.equal(message.extra.reasoning, 'host-owned');
  assert.equal(saves, 2);
});

test('单个开关只执行对应清理；默认关闭时正确消息不写入', async () => {
  const correct = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n${sdcEnd('1年夏5日', '周五', '12:30')}\n</content>`;
  __testContext.chat = [messageFixture(correct)];
  controller.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [] });
  const result = await controller.triggerManualFix('0');
  assert.equal(result.success, false);
  assert.equal(saves, 0);

  const leakOnly = '<thinking>泄漏</thinking>\n<content>正文</content>';
  __testContext.chat = [messageFixture(leakOnly)];
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [],
    removeLeakedReasoning: true, repairSdcBoundary: false,
  });
  const cleaned = await controller.triggerManualFix('0');
  assert.equal(cleaned.success, true);
  assert.equal(__testContext.chat[0].mes, '<content>正文</content>');
});

test('自动修复受 autoFix 门控、只写一次且不会因自身渲染事件重复修复', async () => {
  const source = '<thinking>泄漏</thinking>\n<content>正文</content>';
  __testContext.chat = [messageFixture(source, { extra: { reasoning: 'host-owned' } })];
  controller.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [], removeLeakedReasoning: true });
  await messageHandler._processMessage('0');
  assert.equal(saves, 0);
  assert.equal(__testContext.chat[0].mes, source);
  messageHandler.lastContent.clear();

  controller.updateSettings({ enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [], removeLeakedReasoning: true });
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.equal(__testContext.chat[0].mes, '<content>正文</content>');
  assert.equal(__testContext.chat[0].extra.reasoning, 'host-owned');
  assert.equal(saves, 1);

  await messageHandler._processMessage('0');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(saves, 1, 'same content is deduplicated');
});

test('自动修复与普通规则可合并执行，且不会重复入队', async () => {
  const rule = { id: 'r', name: '正文', enabled: true, requiredContent: ['<content>', '</content>'], fixStrategy: 'add-missing-tags' };
  UIState.rules = [rule];
  const source = '<thinking>泄漏</thinking>\n<content>正文';
  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({
    enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [rule], removeLeakedReasoning: true,
  });
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.equal(__testContext.chat[0].mes, '<content>正文\n</content>');
  assert.equal(saves, 1);
});

test('统一规划失败/歧义/流式抑制仍标记 handled，不再落回旧协调器重复入队', async () => {
  const rule = { id: 'fail-rule', name: '失败规则', enabled: true, requiredContent: ['<never>'], fixStrategy: 'unknown' };
  UIState.rules = [rule];
  const ambiguous = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n${sdcStart('1年夏5日', '周五', '12:21')}\n正文\n</content>`;
  __testContext.chat = [messageFixture(ambiguous)];
  controller.updateSettings({
    enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [rule],
    removeLeakedReasoning: true, repairSdcBoundary: true, sdcCalendarSource: 'gouhua',
  });
  const failedPromise = waitForEvent('responseLinter.validationFailed');
  await controller._handleMessageProcessed({ messageId: '0', content: ambiguous, name: 'AI' });
  const failed = await failedPromise;
  assert.equal(failed.result.metadata.handledByRepairPlan, true);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(controller.getFixStatistics().totalAttempts, 0);
  assert.equal(saves, 0);
  assert.equal(fixCoordinator.fixQueue.length, 0);

  const missingCalendar = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>`;
  __testContext.chat = [messageFixture(missingCalendar)];
  __testContext.chatMetadata = {};
  const missingCalendarPromise = waitForEvent('responseLinter.validationFailed');
  await controller._handleMessageProcessed({ messageId: '0', content: missingCalendar, name: 'AI' });
  const missingCalendarFailed = await missingCalendarPromise;
  assert.equal(missingCalendarFailed.result.metadata.handledByRepairPlan, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(controller.getFixStatistics().totalAttempts, 0);
  assert.equal(saves, 0);

  __testContext.streamingProcessor = { isFinished: false };
  __testContext.chat = [messageFixture(ambiguous)];
  controller.updateSettings({
    enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [rule],
    removeLeakedReasoning: true, repairSdcBoundary: true, sdcCalendarSource: 'four-seasons-28',
  });
  const streamingPromise = waitForEvent('responseLinter.validationFailed');
  await controller._handleMessageProcessed({ messageId: '0', content: ambiguous, name: 'AI' });
  const streaming = await streamingPromise;
  assert.equal(streaming.result.metadata.handledByRepairPlan, true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(controller.getFixStatistics().totalAttempts, 0);
  assert.equal(saves, 0);
  assert.equal(fixCoordinator.fixQueue.length, 0);
});

test('手动预览：取消不写入，确认后保存一次并可撤销；预览不改消息', async () => {
  const source = '<thinking>泄漏</thinking>\n<content>正文</content>';
  __testContext.chat = [messageFixture(source)];
  const before = structuredClone(__testContext.chat[0]);
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'preview', rules: [], removeLeakedReasoning: true,
  });

  const pending = await controller.triggerManualFix('0');
  assert.equal(pending.metadata?.requiresConfirmation, true);
  assert.equal(saves, 0);
  const cancelled = await controller.confirmFix('0', false);
  assert.equal(cancelled.success, false);
  assert.deepEqual(__testContext.chat[0], before);

  const pendingAgain = await controller.triggerManualFix('0');
  assert.equal(pendingAgain.metadata?.requiresConfirmation, true);
  assert.equal((await controller.confirmFix('0', true)).success, true);
  assert.equal(__testContext.chat[0].mes, '<content>正文</content>');
  assert.equal(saves, 1);
  assert.equal((await controller.undoFix('0')).success, true);
  assert.equal(__testContext.chat[0].mes, before.mes);
  assert.equal(saves, 2);

  // previewLatestFix 也是零写入，并恢复 autoFixEngine 的启用状态。
  __testContext.chat = [messageFixture(source)];
  const autoWasEnabled = (await import('../core/auto-fix-engine.js')).autoFixEngine.isEnabled;
  const preview = controller.previewLatestFix();
  assert.equal(preview.success, true);
  assert.equal(preview.newContent, '<content>正文</content>');
  assert.equal(saves, 2);
  assert.equal((await import('../core/auto-fix-engine.js')).autoFixEngine.isEnabled, autoWasEnabled);
});

test('预览确认与队列都校验当前消息/swipe 身份，切换后拒绝覆盖', async () => {
  const firstSwipe = '<thinking>泄漏一</thinking>\n<content>正文一</content>';
  const secondSwipe = '<thinking>泄漏二</thinking>\n<content>正文二</content>';
  __testContext.chat = [messageFixture(firstSwipe, { swipe: firstSwipe })];
  __testContext.chat[0].swipes.push(secondSwipe);
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'preview', rules: [], removeLeakedReasoning: true,
  });

  await controller.triggerManualFix('0');
  __testContext.chat[0].swipe_id = 1;
  __testContext.chat[0].mes = secondSwipe;
  const switchedSwipe = await controller.confirmFix('0', true);
  assert.equal(switchedSwipe.success, false);
  assert.equal(saves, 0);

  __testContext.chat = [{ mes: '<content>另一个聊天', is_user: false, swipe_id: 0, swipes: ['<content>另一个聊天'] }];
  await controller.triggerManualFix('0');
  __testContext.chat = [{ mes: '<content>第三个聊天', is_user: false, swipe_id: 0, swipes: ['<content>第三个聊天'] }];
  assert.equal((await controller.confirmFix('0', true)).success, false);
  assert.equal(saves, 0);
});

test('流式生成期间不自动写入/不入队；手动与确认给出明确提示', async () => {
  const source = '<thinking>泄漏</thinking>\n<content>正文</content>';
  __testContext.chat = [messageFixture(source)];
  __testContext.streamingProcessor = { isFinished: false };
  controller.updateSettings({ enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [], removeLeakedReasoning: true });
  await messageHandler._processMessage('0');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(saves, 0);
  assert.equal(__testContext.chat[0].mes, source);

  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, false);
  assert.match(manual.reason, /流式/);
  assert.equal(saves, 0);

  __testContext.streamingProcessor = null;
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.equal(__testContext.chat[0].mes, '<content>正文</content>');
  assert.equal(saves, 1);
});

test('未闭合推理的警告进入手动结果与预览确认信息', async () => {
  const source = `<content>\n${sdcStart('1年夏5日', '周五', '12:20')}\n正文\n</content>\n<thinking>边界不明`;
  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'preview', rules: [],
    removeLeakedReasoning: true, repairSdcBoundary: true, sdcCalendarSource: 'four-seasons-28',
  });
  const confirmationPromise = new Promise(resolve => {
    const handler = event => { document.removeEventListener('responseLinter.confirmationRequired', handler); resolve(event.detail); };
    document.addEventListener('responseLinter.confirmationRequired', handler);
  });
  const pending = await controller.triggerManualFix('0');
  assert.equal(pending.metadata?.requiresConfirmation, true);
  assert.ok(pending.warnings.some(item => /未闭合/.test(item)));
  const confirmation = await confirmationPromise;
  assert.equal(confirmation.messageId, '0');
  assert.ok(confirmation.warnings.length > 0);
  await controller.confirmFix('0', false);
  assert.equal(saves, 0);
});

test('设置导入导出：有效配置往返，非法导入不覆盖之前有效快照', () => {
  const previous = {
    removeLeakedReasoning: true,
    repairSdcBoundary: false,
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 20,
  };
  const exported = createStructureSettingsExport({
    ...previous,
    repairSdcBoundary: true,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: JSON.stringify({
      months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
      weekdayCycle: 7,
      dateFormat: '{year}年{month}{day}日',
      advanceMinutes: 30,
    }),
  });
  const roundTrip = importStructureSettingsText(JSON.stringify(exported), previous);
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.settings.repairSdcBoundary, true);
  assert.equal(roundTrip.settings.sdcCalendarSource, 'custom');
  assert.equal(roundTrip.settings.sdcAdvanceMinutes, 20);

  const before = structuredClone(previous);
  const badSource = importStructureSettingsText(JSON.stringify({ sdcCalendarSource: 'nonsense' }), previous);
  assert.equal(badSource.ok, false);
  const badCustom = importStructureSettingsText(JSON.stringify({ sdcCalendarSource: 'custom', sdcCustomCalendarJson: '{"months":[{"name":"春","days":0}]}' }), previous);
  assert.equal(badCustom.ok, false);
  const badAdvance = importStructureSettingsText(JSON.stringify({ sdcAdvanceMinutes: 0 }), previous);
  assert.equal(badAdvance.ok, false);
  assert.deepEqual(previous, before);
  assert.equal(badSource.settings, undefined);

  const direct = importStructureSettingsText(JSON.stringify({
    months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
    weekdayCycle: 7,
    dateFormat: '{year}年{month}{day}日',
    advanceMinutes: 15,
  }), previous);
  assert.equal(direct.ok, true);
  assert.equal(direct.settings.sdcCalendarSource, 'custom');
  assert.equal(direct.settings.sdcAdvanceMinutes, 15);
  assert.equal(parseCustomCalendarConfig(direct.settings.sdcCustomCalendarJson).ok, true);

  assert.equal(importStructureSettingsText('{}', previous).ok, false);
  assert.equal(importStructureSettingsText(JSON.stringify({ format: 'response-linter-structure-settings', version: 2, sdcAdvanceMinutes: 10 }), previous).ok, false);
  assert.equal(importStructureSettingsText(JSON.stringify({ removeLeakedReasoning: 'true' }), previous).ok, false);
  assert.equal(importStructureSettingsText(JSON.stringify({ sdcAdvanceMinutes: '20' }), previous).ok, false);
  assert.equal(importStructureSettingsText(JSON.stringify({ sdcCalendarSource: 3 }), previous).ok, false);
  assert.deepEqual(previous, before);
});

test('导出往返保留未显式 advanceMinutes 的自定义 JSON，有效推进分钟不变', () => {
  const previous = {
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: JSON.stringify({
      months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
      weekdayCycle: 7,
      dateFormat: '{year}年{month}{day}日',
    }),
    sdcAdvanceMinutes: 20,
  };
  const beforeContent = `<content>\n${sdcStart('1年夏28日', '周日', '23:50')}\n正文\n</content>`;
  const beforeEffective = transformContent(beforeContent, previous, { chatMetadata: {} });

  const exported = createStructureSettingsExport(previous);
  const exportedCustom = JSON.parse(exported.sdcCustomCalendarJson);
  assert.equal(exportedCustom.advanceMinutes, undefined, 'synthetic advanceMinutes omitted');
  const imported = importStructureSettingsText(JSON.stringify(exported), previous);
  assert.equal(imported.ok, true);
  assert.equal(imported.settings.sdcAdvanceMinutes, 20);
  const importedCustom = JSON.parse(imported.settings.sdcCustomCalendarJson);
  assert.equal(importedCustom.advanceMinutes, undefined);
  const afterEffective = transformContent(beforeContent, imported.settings, { chatMetadata: {} });
  assert.equal(afterEffective.changed, true);
  assert.equal(afterEffective.content, beforeEffective.content);
  assert.ok(afterEffective.content.includes(sdcEnd('2年春1日', '周一', '00:10')));
});

test('设置合并保留既有规则与未知字段，两个开关独立持久化', () => {
  const base = {
    enabled: true,
    autoFix: false,
    rules: [{ id: 'legacy', name: '旧规则', enabled: true, requiredContent: ['<content>'] }],
    notifications: { duration: 5, showSuccess: true },
    untouched: 'keep',
  };
  const validJson = JSON.stringify({ months: [{ name: '春', days: 28 }], weekdayCycle: 7, dateFormat: '{year}年{month}{day}日' });
  const merged = mergeFeatureSettings(base, {
    removeLeakedReasoning: true,
    repairSdcBoundary: false,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: validJson,
    sdcAdvanceMinutes: 25,
  });
  assert.deepEqual(merged.warnings, []);
  Object.assign(base, merged.fields);
  assert.deepEqual(base.rules, [{ id: 'legacy', name: '旧规则', enabled: true, requiredContent: ['<content>'] }]);
  assert.equal(base.notifications.duration, 5);
  assert.equal(base.untouched, 'keep');
  assert.equal(base.removeLeakedReasoning, true);
  assert.equal(base.repairSdcBoundary, false);
  assert.equal(base.sdcCalendarSource, 'custom');
  assert.equal(base.sdcAdvanceMinutes, 25);

  const previous = structuredClone(base);
  const invalid = mergeFeatureSettings(previous, {
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: '{"months":[{"name":"春","days":0}]}',
    sdcAdvanceMinutes: 0,
  });
  assert.ok(invalid.warnings.length >= 2);
  assert.equal(invalid.fields.sdcCalendarSource, previous.sdcCalendarSource);
  assert.equal(invalid.fields.sdcCustomCalendarJson, previous.sdcCustomCalendarJson);
  assert.equal(invalid.fields.sdcAdvanceMinutes, previous.sdcAdvanceMinutes);
  assert.equal(readFeatureSettings({}).removeLeakedReasoning, false);
});

test('首次选择自定义历法会填充有效可编辑草稿，非法编辑不隐藏输入且保留上次有效配置', () => {
  const seededBlank = seedCustomCalendarDraft('', '');
  assert.equal(seededBlank.seeded, true);
  assert.ok(seededBlank.text.trim());
  assert.equal(parseCustomCalendarConfig(seededBlank.text).ok, true);

  const existingDraft = seedCustomCalendarDraft('用户草稿', '');
  assert.equal(existingDraft.text, '用户草稿');
  const existingSaved = seedCustomCalendarDraft('', CUSTOM_CALENDAR_PRESET_JSON);
  assert.equal(existingSaved.text, CUSTOM_CALENDAR_PRESET_JSON);
  assert.equal(existingSaved.seeded, false);

  const previousGouhua = {
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    sdcCalendarSource: 'gouhua',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 10,
  };
  const invalidCustom = mergeFeatureSettings(previousGouhua, {
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: '{bad json',
    sdcAdvanceMinutes: 10,
  });
  assert.equal(invalidCustom.fields.sdcCalendarSource, 'custom', 'selected custom remains visible');
  assert.equal(invalidCustom.fields.sdcCustomCalendarJson, '', 'invalid draft does not overwrite persisted config');
  assert.ok(invalidCustom.warnings.some(item => /草稿仍保留/.test(item)));
});

test('当前聊天设置可直接控制手动修复按钮，不依赖 window 设置镜像或用户规则', () => {
  const props = {};
  globalThis.$ = selector => ({
    prop(key, value) {
      if (arguments.length > 1) { props[`${selector}:${key}`] = value; return this; }
      return props[`${selector}:${key}`];
    },
    text() { return this; },
    toggleClass() { return this; },
    addClass() { return this; },
    removeClass() { return this; },
    attr() { return this; },
  });
  const ui = new UIStateManager();
  window.extension_settings = {};
  window.backendController = {
    getLatestAIMessage: () => ({ id: '0', content: '<content>正文' }),
    canUndoFix: () => false,
  };
  __testContext.extensionSettings['response-linter'] = { enabled: true, removeLeakedReasoning: true, repairSdcBoundary: true, rules: [] };
  ui.refreshManualFixButton();
  assert.equal(props['#rl-manual-fix:disabled'], false);
  assert.equal(props['#rl-undo-fix:disabled'], true);

  __testContext.extensionSettings['response-linter'] = { enabled: false, rules: [] };
  ui.refreshManualFixButton();
  assert.equal(props['#rl-manual-fix:disabled'], true);
  delete globalThis.$;
  delete window.backendController;
  delete window.extension_settings;
});

test('持久化设置中的开关字段被读取，缺失字段默认关闭；非法自定义历法不改变之前有效快照', () => {
  const persisted = {
    enabled: true,
    autoFix: false,
    removeLeakedReasoning: true,
    repairSdcBoundary: false,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: JSON.stringify({ months: [{ name: '春', days: 28 }], weekdayCycle: 7, dateFormat: '{year}年{month}{day}日' }),
    sdcAdvanceMinutes: 10,
  };
  __testContext.extensionSettings['response-linter'] = persisted;
  const normalized = normalizeRepairSettings(persisted);
  assert.equal(normalized.removeLeakedReasoning, true);
  assert.equal(normalized.repairSdcBoundary, false);
  assert.equal(normalized.advanceMinutes, 10);

  const before = structuredClone(persisted);
  const invalid = parseCustomCalendarConfig('{"months":[{"name":"春","days":0}]}');
  assert.equal(invalid.ok, false);
  assert.deepEqual(__testContext.extensionSettings['response-linter'], before);
  assert.equal(JSON.parse(__testContext.extensionSettings['response-linter'].sdcCustomCalendarJson).months[0].days, 28);
});

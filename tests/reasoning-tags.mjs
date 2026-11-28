import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformContent } from '../core/repair-service.js';
import { createStructureSettingsExport, importStructureSettingsText } from '../core/settings-transfer.js';
import { validateStructureProfile } from '../core/structure-profiles.js';

const profile = {
  id: 'reasoning-example',
  name: '推理标签测试',
  body: { open: '<content>', close: '</content>' },
  time: { mode: 'sdc' },
};
const body = '<content>实际正文</content>';
const settingsFor = (active = profile) => ({
  removeLeakedReasoning: true,
  structureProfiles: [active],
  structureProfileId: active.id,
});
const repair = (source, active = profile) => transformContent(source, settingsFor(active));

test('an orphan think closer followed by a complete thinking block is removed with the reasoning', () => {
  const result = repair('</think><thinking>\n思考内容……\n</thinking>\n' + body);
  assert.equal(result.content, body);
  assert.deepEqual(result.warnings, []);
});

test('a single thinking closer removes just the marker and preserves surrounding words', () => {
  const result = repair('<content>正文前半</thinking>，正文后半。</content>');
  assert.equal(result.content, '<content>正文前半，正文后半。</content>');
  assert.deepEqual(result.warnings, []);
});

test('a stray think closer before the body removes the leading reasoning tail', () => {
  const result = repair('\x60收束\n</think>\n' + body);
  assert.equal(result.content, body);
  assert.equal(result.details.reasoning.removedLeaks, 1);
  assert.equal(repair(result.content).changed, false);
});

test('leading reasoning ends at the last orphan closer before the first anchor', () => {
  const result = repair('前半</think>\n收束</THINKING>引子\n<content>正文</think>后半</content>');
  assert.equal(result.content, '引子\n<content>正文后半</content>');
});

test('leading reasoning cleanup uses the active profile body delimiter or time start', () => {
  const active = {
    ...profile,
    body: { open: '<story>', close: '</story>' },
    time: { mode: 'none' },
    reasoning: { blocks: ['konatan_planning~'], tagsOnly: [] },
  };
  const story = '<story>实际正文</story>';
  assert.equal(repair('收束</konatan_planning~>\n' + story, active).content, story);

  const start = '<!-- SDC-start | date=1年夏6日 | weekday=周六 | time=20:10 -->\r\n正文';
  assert.equal(repair('\n收束\r\n</thinking>\r\n' + start).content, start);
});

test('an orphan closer without a real body anchor preserves the text before it', () => {
  for (const tail of [
    '正文',
    '\n行内示例 \x60<content>\x60',
    '\n<span title="<content>">属性示例</span>',
    '\n<!-- 说明：<content> -->',
  ]) {
    assert.equal(repair('保留这段</think>' + tail).content, '保留这段' + tail);
  }
});

test('a leading orphan closer does not erase an earlier mismatched reasoning block', () => {
  const active = { ...profile, reasoning: { blocks: ['think', 'thinking', 'plan'], tagsOnly: [] } };
  const prefix = '<think>配对不明</thinking>\n收束';
  const result = repair(prefix + '</plan>\n' + body, active);
  assert.equal(result.content, prefix + '\n' + body);
  assert.match(result.warnings.join(' '), /错配/);
});

test('a chosen block name ending in a tilde is recognized, including the angle-bracket entry form', () => {
  const text = '<konatan_planning~>\n思考内容……\n</konatan_planning~>\n' + body;
  const active = { ...profile, reasoning: { blocks: ['<konatan_planning~>'], tagsOnly: [] } };
  assert.equal(repair(text).content, text, 'custom tags require a profile choice');
  assert.equal(repair(text, active).content, body);
  assert.equal(repair('<think>用户没有选择的标签</think>\n' + body, active).changed, false);
});

test('the tags-only list removes both wrappers and single markers without modifying whitespace or contents', () => {
  const active = { ...profile, reasoning: { blocks: ['think'], tagsOnly: ['</Konatan_Planning~>'] } };
  const text = '<content>前半  <konatan_planning~>\n保留这里\n</konatan_planning~> </konatan_planning~> 后半</content>';
  const result = repair(text, active);
  assert.equal(result.content, '<content>前半  \n保留这里\n  后半</content>');
  assert.equal(repair(result.content, active).changed, false);
  assert.equal(repair('保留这里</konatan_planning~>\n' + body, active).content, '保留这里\n' + body);
});

test('unclosed custom reasoning stops at a real time anchor and stays intact if there is no clear end', () => {
  const active = { ...profile, reasoning: { blocks: ['konatan_planning~'], tagsOnly: [] } };
  const anchor = '<!-- SDC-start | date=1年夏6日 | weekday=周六 | time=20:10 -->';
  const text = '<Konatan_Planning~ note="a > b">思考内容\n' + anchor + '\n' + body;
  assert.equal(repair(text, active).content, anchor + '\n' + body);
  const unclear = '<content>正文<konatan_planning~>边界不明的文本</content>';
  const result = repair(unclear, active);
  assert.equal(result.content, unclear);
  assert.match(result.warnings.join(' '), /未闭合/);
});

test('configured reasoning tags inside code, ordinary HTML comments or another tag attribute stay intact', () => {
  const active = { ...profile, reasoning: { blocks: ['konatan_planning~'], tagsOnly: ['think'] } };
  const text = [
    '~~~html', '<konatan_planning~>代码</konatan_planning~>', '~~~',
    '\x60</konatan_planning~>\x60',
    '<!-- <konatan_planning~>注释</konatan_planning~> -->',
    '<span title="<think>">属性</span>', '<code><think>示例</think></code>',
    body,
  ].join('\n');
  assert.equal(repair(text, active).content, text);
});

test('a quoted or unclosed example of a body or time anchor cannot authorize deletion', () => {
  for (const text of [
    '<think>尚未闭合 <span title="<content>">演示</span>',
    '<think>尚未闭合 <!-- 说明：<content> 演示 -->',
    '<think>尚未闭合 <!-- SDC-start | date=示例未结束',
  ]) {
    const result = repair(text);
    assert.equal(result.content, text);
    assert.match(result.warnings.join(' '), /未闭合/);
  }
});

test('tag modes round-trip through configuration import/export and conflicting rules are rejected', () => {
  const active = { ...profile, reasoning: { blocks: ['<KONATAN_planning~>'], tagsOnly: ['</think>'] } };
  const exported = createStructureSettingsExport(settingsFor(active));
  const imported = importStructureSettingsText(JSON.stringify(exported), {});
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.settings.structureProfiles[0].reasoning, {
    blocks: ['konatan_planning~'], tagsOnly: ['think'],
  });
  for (const reasoning of [
    { blocks: ['think'], tagsOnly: ['<Think>'] },
    { blocks: ['content'], tagsOnly: [] },
    { blocks: ['think.*'], tagsOnly: [] },
  ]) assert.equal(validateStructureProfile({ ...profile, reasoning }).ok, false);
});

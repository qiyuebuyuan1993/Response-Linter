// Shared, single-instance structure-profile editor. The DOM is created once
// from settings.html; this module never replaces the live form on save.
import {
  LEGACY_PROFILE_ID,
  STRUCTURE_PROFILES_VERSION,
  cloneProfile,
  createBlankProfile,
  createLegacyProfile,
  moveProfileBlock,
  readStructureProfiles,
  validateStructureProfile,
} from '../../core/structure-profiles.js';

function nowId(prefix = 'custom') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function asText(value) {
  return value == null ? '' : String(value);
}

export class StructureProfileUI {
  constructor() {
    this.initialized = false;
    this.collection = null;
    this.profiles = [];
    this.activeProfileId = '';
    this.currentDraft = null;
    this.currentDraftId = '';
    this.drafts = new Map();
    this.dirty = false;
    this.getSettings = () => ({});
    this.persistProfiles = async () => ({ ok: false, warnings: ['尚未连接设置保存接口。'] });
    this.notify = () => {};
  }

  initialize(options = {}) {
    if (this.initialized) return;
    this.initialized = true;
    this.getSettings = options.getSettings || this.getSettings;
    this.persistProfiles = options.persistProfiles || this.persistProfiles;
    this.notify = options.notify || this.notify;
    const root = document.getElementById('rl-profile-editor');
    if (!root) return;

    document.getElementById('rl-profile-select')
      ?.addEventListener('change', event => this.selectProfile(event.target.value));
    document.getElementById('rl-profile-new')
      ?.addEventListener('click', () => this.beginNew());
    document.getElementById('rl-profile-copy')
      ?.addEventListener('click', () => this.copyCurrent());
    document.getElementById('rl-profile-remove')
      ?.addEventListener('click', () => this.removeCurrent());
    document.getElementById('rl-profile-restore-legacy')
      ?.addEventListener('click', () => this.restoreLegacy());
    document.getElementById('rl-profile-save')
      ?.addEventListener('click', () => this.saveDraft());
    document.getElementById('rl-profile-discard')
      ?.addEventListener('click', () => this.discardDraft());
    document.getElementById('rl-profile-add-block')
      ?.addEventListener('click', () => this.addBlock());
    document.getElementById('rl-profile-time-mode')
      ?.addEventListener('change', () => {
        this.dirty = true;
        this.updateTimeVisibility();
      });
    document.getElementById('rl-profile-blocks-list')
      ?.addEventListener('click', event => {
        const button = event.target?.closest?.('button[data-rl-block-action]');
        if (!button) return;
        const index = Number(button.dataset.rlBlockIndex);
        this.handleBlockAction(button.dataset.rlBlockAction, index);
      });
    for (const id of [
      'rl-profile-name', 'rl-profile-body-open', 'rl-profile-body-close',
      'rl-profile-time-start', 'rl-profile-time-end', 'rl-profile-auxiliaries',
    ]) {
      document.getElementById(id)?.addEventListener('input', () => { this.dirty = true; });
    }
    this.refreshFromSettings();
  }

  getMemoryProfiles() {
    if (Array.isArray(this.profiles) && this.profiles.length) return this.profiles;
    return readStructureProfiles(this.getSettings()).profiles;
  }

  refreshFromSettings({ preserveDraft = true } = {}) {
    // Explicit load/import replaces editor drafts, including those cached
    // while switching profiles. Otherwise stale drafts can hide imported data.
    if (!preserveDraft) this.drafts.clear();
    const settings = this.getSettings();
    const collection = readStructureProfiles(settings);
    this.collection = collection;
    this.profiles = collection.profiles.map(profile => ({ ...profile }));
    this.activeProfileId = collection.activeProfileId;
    if (preserveDraft && this.currentDraft && this.dirty) {
      const captured = this.captureDraftFromForm();
      this.drafts.set(this.currentDraftId, captured);
      this.currentDraft = captured;
      // Keep rendering the captured draft, not a stale pre-edit object.
    } else {
      const active = this.profiles.find(profile => profile.id === this.activeProfileId)
        || this.profiles[0]
        || createLegacyProfile(settings);
      this.currentDraft = this.drafts.get(active.id) || JSON.parse(JSON.stringify(active));
      this.currentDraftId = active.id;
      this.dirty = false;
    }
    this.renderSelect();
    this.renderEditor();
  }

  renderSelect() {
    const select = document.getElementById('rl-profile-select');
    if (!select) return;
    select.innerHTML = '';
    for (const profile of this.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.builtin ? `${profile.name}（内置）` : profile.name;
      option.selected = profile.id === this.currentDraftId || (!this.currentDraftId && profile.id === this.activeProfileId);
      select.appendChild(option);
    }
    if (this.currentDraft && !this.profiles.some(profile => profile.id === this.currentDraft.id)) {
      const option = document.createElement('option');
      option.value = this.currentDraft.id;
      option.textContent = `${this.currentDraft.name || '新档案'}（未保存草稿）`;
      option.selected = true;
      select.appendChild(option);
    }
  }

  setReadonly(readonly, message = '') {
    const ids = [
      'rl-profile-name', 'rl-profile-body-open', 'rl-profile-body-close',
      'rl-profile-time-mode', 'rl-profile-time-start', 'rl-profile-time-end',
      'rl-profile-auxiliaries', 'rl-profile-add-block', 'rl-profile-save',
      'rl-profile-discard',
    ];
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) element.disabled = readonly;
    }
    for (const element of document.querySelectorAll(
      '#rl-profile-blocks-list input, #rl-profile-blocks-list textarea, #rl-profile-blocks-list select, #rl-profile-blocks-list button',
    )) {
      element.disabled = readonly;
    }
    const note = document.getElementById('rl-profile-readonly-note');
    if (note) {
      note.style.display = readonly ? 'block' : 'none';
      if (message) note.textContent = message;
    }
  }

  renderEditor() {
    const draft = this.currentDraft;
    if (!draft) return;
    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.value = asText(value);
    };
    set('rl-profile-name', draft.name);
    set('rl-profile-body-open', draft.body?.open);
    set('rl-profile-body-close', draft.body?.close);
    set('rl-profile-time-mode', draft.time?.mode || 'none');
    set('rl-profile-time-start', draft.time?.startTemplate || '');
    set('rl-profile-time-end', draft.time?.endTemplate || '');
    set('rl-profile-auxiliaries', (draft.auxiliaries || []).join('\n'));
    this.renderBlocks(draft);
    this.updateTimeVisibility();
    const builtin = draft.builtin === true;
    this.setReadonly(builtin, '旧版预设用于兼容旧设置，不能直接编辑；请先“复制为自定义”。');
    const remove = document.getElementById('rl-profile-remove');
    if (remove) remove.disabled = builtin;
  }

  renderBlocks(draft) {
    const list = document.getElementById('rl-profile-blocks-list');
    if (!list) return;
    list.innerHTML = '';
    (draft.blocks || []).forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'rl-profile-block';
      row.dataset.rlBlockIndex = String(index);
      const grid = document.createElement('div');
      grid.className = 'rl-profile-block-grid';
      const fields = [
        ['标签', 'label', block.label, '例如：选项'],
        ['开始分隔符', 'open', block.open, '<选项>'],
        ['结束分隔符', 'close', block.close, '</选项>'],
        ['直接标题元素（可选）', 'titleTag', block.titleTag, 'summary'],
        ['标题关键词（可选）', 'titleKeyword', block.titleKeyword, '你的选择是'],
      ];
      for (const [labelText, key, value, placeholder] of fields) {
        const label = document.createElement('label');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole';
        input.value = asText(value);
        input.placeholder = placeholder;
        input.maxLength = key === 'titleKeyword' ? 80 : 240;
        input.dataset.rlBlockField = key;
        input.dataset.rlBlockIndex = String(index);
        input.addEventListener('input', () => { this.dirty = true; });
        label.appendChild(input);
        grid.appendChild(label);
      }
      row.appendChild(grid);
      const actions = document.createElement('div');
      actions.className = 'rl-profile-block-actions';
      const actionButtons = [
        ['up', '↑ 上移', index === 0],
        ['down', '↓ 下移', index === (draft.blocks || []).length - 1],
        ['remove', '删除', false],
      ];
      for (const [action, text, disabled] of actionButtons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button secondary small rl-profile-block-${action}`;
        button.dataset.rlBlockAction = action;
        button.dataset.rlBlockIndex = String(index);
        button.textContent = text;
        button.disabled = disabled || draft.builtin === true;
        actions.appendChild(button);
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  updateTimeVisibility() {
    const mode = document.getElementById('rl-profile-time-mode')?.value || 'none';
    const custom = document.getElementById('rl-profile-custom-time');
    if (custom) custom.style.display = mode === 'custom' ? 'block' : 'none';
    for (const id of ['rl-profile-time-start', 'rl-profile-time-end']) {
      const element = document.getElementById(id);
      if (element) element.disabled = (this.currentDraft?.builtin === true) || mode !== 'custom';
    }
  }

  captureDraftFromForm() {
    const value = id => document.getElementById(id)?.value ?? '';
    const blocks = [];
    const list = document.getElementById('rl-profile-blocks-list');
    if (list) {
      for (const row of list.querySelectorAll('.rl-profile-block')) {
        const read = field => row.querySelector(`[data-rl-block-field="${field}"]`)?.value ?? '';
        const index = Number(row.dataset.rlBlockIndex);
        const original = this.currentDraft?.blocks?.[index] || {};
        blocks.push({
          id: original.id || nowId('block'),
          label: read('label').trim(),
          open: read('open'),
          close: read('close'),
          titleTag: read('titleTag').trim(),
          titleKeyword: read('titleKeyword').trim(),
        });
      }
    }
    return {
      ...(this.currentDraft || {}),
      version: STRUCTURE_PROFILES_VERSION,
      id: this.currentDraft?.id || this.currentDraftId || nowId(),
      name: value('rl-profile-name').trim(),
      builtin: this.currentDraft?.builtin === true,
      body: { open: value('rl-profile-body-open'), close: value('rl-profile-body-close') },
      time: {
        mode: value('rl-profile-time-mode') || 'none',
        startTemplate: value('rl-profile-time-start'),
        endTemplate: value('rl-profile-time-end'),
      },
      auxiliaries: value('rl-profile-auxiliaries').split(/\r?\n/).map(item => item.trim()).filter(Boolean),
      blocks,
    };
  }

  setMessage(text, isError = false) {
    const element = document.getElementById('rl-profile-messages');
    if (!element) return;
    element.textContent = text || '';
    element.classList.toggle('rl-profile-error', !!isError);
  }

  selectProfile(profileId) {
    if (!profileId) return;
    if (profileId === this.currentDraftId) return;
    if (this.dirty || this.currentDraft) {
      this.drafts.set(this.currentDraftId, this.captureDraftFromForm());
    }
    const profile = this.profiles.find(item => item.id === profileId);
    if (!profile) {
      this.setMessage('选中的结构配置档案不存在，已保留当前编辑。', true);
      this.renderSelect();
      return;
    }
    this.currentDraftId = profile.id;
    this.currentDraft = this.drafts.get(profile.id) || JSON.parse(JSON.stringify(profile));
    this.dirty = false;
    this.renderEditor();
    this.persistActive(profile.id);
  }

  async persistActive(profileId) {
    const result = await this.persistProfiles(this.profiles, profileId);
    if (!result?.ok) {
      this.setMessage((result?.warnings || ['无法保存当前档案选择。']).join(' '), true);
      return false;
    }
    this.activeProfileId = profileId;
    this.refreshFromSettings({ preserveDraft: true });
    return true;
  }

  beginNew() {
    this.drafts.set(this.currentDraftId, this.captureDraftFromForm());
    const baseName = '自定义结构';
    let candidate = baseName;
    let suffix = 2;
    while (this.profiles.some(profile => profile.name === candidate)) {
      candidate = `${baseName} ${suffix++}`;
    }
    const draft = createBlankProfile({
      id: nowId(),
      name: candidate,
    });
    draft.blocks = [];
    this.currentDraft = draft;
    this.currentDraftId = draft.id;
    this.dirty = true;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('新档案尚未保存；填写后点击“保存档案”。');
  }

  copyCurrent() {
    const source = this.dirty || !this.currentDraft
      ? this.captureDraftFromForm()
      : this.currentDraft;
    let name = `${source.name} 副本`;
    let suffix = 2;
    while (this.profiles.some(profile => profile.name === name)) name = `${source.name} 副本 ${suffix++}`;
    const copied = cloneProfile(source, {
      id: nowId('copy'),
      name,
      builtin: false,
    });
    if (!copied) {
      this.setMessage('当前档案内容无效，无法复制；已保留原草稿。', true);
      return;
    }
    this.drafts.set(this.currentDraftId, this.captureDraftFromForm());
    this.currentDraft = copied;
    this.currentDraftId = copied.id;
    this.dirty = true;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('已复制为自定义草稿；保存后才会写入设置。');
  }

  async removeCurrent() {
    const profile = this.profiles.find(item => item.id === this.currentDraftId)
      || this.profiles.find(item => item.id === this.activeProfileId);
    if (!profile) return;
    if (profile.builtin) {
      this.setMessage('旧版内置预设不能删除；可选择它作为兼容预设。', true);
      return;
    }
    if (this.profiles.length <= 1) {
      this.setMessage('至少需要保留一个结构配置档案，不能删除最后一个。', true);
      return;
    }
    if (typeof window.confirm === 'function' && !window.confirm(`删除结构配置档案“${profile.name}”？`)) return;
    const next = this.profiles.filter(item => item.id !== profile.id);
    const fallback = next.find(item => item.id === LEGACY_PROFILE_ID) || next[0];
    this.drafts.delete(profile.id);
    const result = await this.persistProfiles(next, fallback.id);
    if (!result?.ok) {
      this.setMessage((result?.warnings || ['删除档案失败，已保留原配置。']).join(' '), true);
      return;
    }
    this.collection = readStructureProfiles(this.getSettings());
    this.profiles = this.collection.profiles.map(item => ({ ...item }));
    this.activeProfileId = this.collection.activeProfileId;
    this.currentDraftId = fallback.id;
    this.currentDraft = JSON.parse(JSON.stringify(fallback));
    this.dirty = false;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('档案已删除。');
  }

  async restoreLegacy() {
    let legacy = this.profiles.find(profile => profile.id === LEGACY_PROFILE_ID);
    if (!legacy) {
      legacy = createLegacyProfile(this.getSettings());
      this.profiles = [legacy, ...this.profiles];
    }
    const result = await this.persistProfiles(this.profiles, legacy.id);
    if (!result?.ok) {
      this.setMessage((result?.warnings || ['恢复旧版预设失败。']).join(' '), true);
      return;
    }
    this.drafts.delete(legacy.id);
    this.activeProfileId = legacy.id;
    this.currentDraftId = legacy.id;
    this.currentDraft = JSON.parse(JSON.stringify(legacy));
    this.dirty = false;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('已选择旧版 SDC / content / details 预设。');
  }

  addBlock() {
    if (this.currentDraft?.builtin) return;
    const draft = this.captureDraftFromForm();
    draft.blocks = draft.blocks || [];
    draft.blocks.push({
      id: nowId('block'),
      label: `结构块 ${draft.blocks.length + 1}`,
      open: '',
      close: '',
      titleTag: '',
      titleKeyword: '',
    });
    this.currentDraft = draft;
    this.dirty = true;
    this.renderBlocks(draft);
  }

  handleBlockAction(action, index) {
    if (this.currentDraft?.builtin || !Number.isInteger(index)) return;
    let draft = this.captureDraftFromForm();
    if (action === 'remove') {
      draft.blocks.splice(index, 1);
    } else if (action === 'up' || action === 'down') {
      const next = moveProfileBlock(draft, index, index + (action === 'up' ? -1 : 1));
      if (!next) return;
      draft = next;
    } else {
      return;
    }
    this.currentDraft = draft;
    this.dirty = true;
    this.renderBlocks(draft);
  }

  async saveDraft() {
    const draft = this.captureDraftFromForm();
    if (!draft || draft.builtin) {
      this.setMessage('内置旧版预设不能直接保存；请复制为自定义。', true);
      return;
    }
    const others = this.profiles.filter(profile => profile.id !== draft.id);
    if (others.some(profile => profile.name === draft.name)) {
      this.setMessage('档案名称必须唯一；已保留当前草稿。', true);
      return;
    }
    const checked = validateStructureProfile(draft);
    if (!checked.ok) {
      this.setMessage(`档案无效：${checked.error} 当前草稿仍保留在编辑器中。`, true);
      return;
    }
    const nextProfiles = this.profiles.some(profile => profile.id === checked.profile.id)
      ? this.profiles.map(profile => profile.id === checked.profile.id ? checked.profile : profile)
      : [...this.profiles, checked.profile];
    const result = await this.persistProfiles(nextProfiles, checked.profile.id);
    if (!result?.ok) {
      this.setMessage((result?.warnings || ['保存档案失败；当前草稿仍保留。']).join(' '), true);
      return;
    }
    this.profiles = nextProfiles;
    this.activeProfileId = checked.profile.id;
    this.currentDraftId = checked.profile.id;
    this.currentDraft = JSON.parse(JSON.stringify(checked.profile));
    this.drafts.delete(checked.profile.id);
    this.dirty = false;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('档案已保存。');
  }

  discardDraft() {
    const profile = this.profiles.find(item => item.id === this.currentDraftId)
      || this.profiles.find(item => item.id === this.activeProfileId)
      || this.profiles[0];
    if (!profile) return;
    this.drafts.delete(this.currentDraftId);
    this.currentDraftId = profile.id;
    this.currentDraft = JSON.parse(JSON.stringify(profile));
    this.dirty = false;
    this.renderSelect();
    this.renderEditor();
    this.setMessage('已放弃未保存的编辑。');
  }

  onPanelOpen() {
    // Re-read persisted profiles but keep the current in-memory draft.
    const settings = this.getSettings();
    const collection = readStructureProfiles(settings);
    this.collection = collection;
    this.profiles = collection.profiles.map(profile => ({ ...profile }));
    this.activeProfileId = collection.activeProfileId;
    this.renderSelect();
    if (!this.currentDraft || !this.dirty) {
      const active = this.profiles.find(profile => profile.id === this.activeProfileId) || this.profiles[0];
      if (active) {
        this.currentDraftId = active.id;
        this.currentDraft = this.drafts.get(active.id) || JSON.parse(JSON.stringify(active));
        this.renderEditor();
      }
    }
  }
}

export const structureProfileUI = new StructureProfileUI();

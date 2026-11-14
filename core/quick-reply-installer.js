// Idempotent installation of one bundled Quick Reply button.
// The installer never replaces a same-name set, never enables Quick Replies
// globally, and never re-adds a button the user removed after a completed install.
import { RESPONSE_LINTER_COMMAND_VERSION } from './quick-reply-command.js';
import {
  QUICK_REPLY_ITEM_LABEL,
  QUICK_REPLY_ITEM_TITLE_MARKER,
  QUICK_REPLY_SET_BASE,
  quickReplyDescriptor,
} from './quick-reply-descriptor.js';

export const QUICK_REPLY_INSTALL_VERSION = 1;
export { QUICK_REPLY_ITEM_LABEL, QUICK_REPLY_ITEM_TITLE_MARKER, QUICK_REPLY_SET_BASE };
const QUICK_REPLY_SHAPE = quickReplyDescriptor();


const REQUIRED_API_METHODS = ['getSetByName', 'listSets', 'listQuickReplies', 'getQrByLabel', 'listGlobalSets', 'addGlobalSet'];
const REQUIRED_OWNER_METHODS = ['createSet', 'createQuickReply'];
const MAX_SET_NAME_SUFFIX = 50;

export function defaultQuickReplyInstallState() {
  return {
    version: QUICK_REPLY_INSTALL_VERSION,
    completed: false,
    setName: '',
    label: QUICK_REPLY_ITEM_LABEL,
    activated: false,
    commandVersion: RESPONSE_LINTER_COMMAND_VERSION,
  };
}

export function normalizeQuickReplyInstallState(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    version: QUICK_REPLY_INSTALL_VERSION,
    completed: raw.completed === true || raw.installed === true,
    setName: typeof raw.setName === 'string' ? raw.setName.slice(0, 120) : '',
    label: typeof raw.label === 'string' && raw.label ? raw.label.slice(0, 80) : QUICK_REPLY_ITEM_LABEL,
    activated: raw.activated === true,
    commandVersion: Number.isInteger(raw.commandVersion) ? raw.commandVersion : RESPONSE_LINTER_COMMAND_VERSION,
  };
}

function apiReady(api) {
  return !!api && REQUIRED_API_METHODS.every(name => typeof api[name] === 'function');
}

function ownerReady(api) {
  return apiReady(api) && REQUIRED_OWNER_METHODS.every(name => typeof api[name] === 'function');
}

function qrMessage() {
  return QUICK_REPLY_SHAPE.button.message;
}

function qrTitle() {
  return QUICK_REPLY_SHAPE.button.title;
}

function listQuickReplies(api, setName) {
  try { return api.listQuickReplies(setName) || []; } catch { return []; }
}

function ownQrs(api, setName) {
  return listQuickReplies(api, setName).filter(label => {
    try {
      const qr = api.getQrByLabel(setName, label);
      return qr && qr.message === qrMessage() && String(qr.title || '').includes(QUICK_REPLY_ITEM_TITLE_MARKER);
    } catch { return false; }
  });
}

function ownedSetName(api, preferred, label) {
  const names = api.listSets();
  const ordered = preferred && names.includes(preferred)
    ? [preferred, ...names.filter(name => name !== preferred)]
    : names;
  for (const name of ordered) {
    if (ownQrs(api, name).length) return name;
  }
  // Also detect our exact button shape in case a previous build wrote it before
  // the marker title existed. Do not claim unrelated buttons.
  for (const name of ordered) {
    try {
      const qr = api.getQrByLabel(name, label);
      if (qr && qr.message === qrMessage()) return name;
    } catch {}
  }
  // A user may edit the button title or label. The persisted preferred set is
  // ownership evidence; an exact command message in it still counts as ours.
  if (preferred && names.includes(preferred)) {
    try {
      const labels = listQuickReplies(api, preferred);
      if (labels.some(item => {
        const qr = api.getQrByLabel(preferred, item);
        return qr && qr.message === qrMessage();
      })) return preferred;
    } catch {}
  }
  return '';
}

function chooseUniqueSetName(api, preferred, label) {
  const names = api.listSets();
  const base = preferred || QUICK_REPLY_SET_BASE;
  if (!names.includes(base)) return base;
  // A set with our marker/button is not a collision; reuse is handled earlier.
  if (ownedSetName(api, base, label)) return base;
  for (let suffix = 2; suffix <= MAX_SET_NAME_SUFFIX; suffix++) {
    const candidate = `${QUICK_REPLY_SET_BASE} (${suffix})`;
    if (!names.includes(candidate)) return candidate;
  }
  return '';
}

function setHasOurGlobal(api, setName) {
  try { return api.listGlobalSets().includes(setName); } catch { return false; }
}

/**
 * @param {Object} options
 * @param {Function} options.getApi
 * @param {Function} options.getCommandReady
 * @param {Function} options.readState
 * @param {Function} options.writeState
 */
export function createQuickReplyInstaller({
  getApi = () => (typeof globalThis !== 'undefined' ? globalThis.quickReplyApi : null),
  getCommandReady = () => true,
  readState = () => defaultQuickReplyInstallState(),
  writeState = () => {},
  notify = () => {},
} = {}) {
  let status = {
    state: 'idle',
    message: '尚未检查 Quick Reply 安装状态。',
    setName: '',
    label: QUICK_REPLY_ITEM_LABEL,
  };
  let pending = Promise.resolve();
  let lastNotifiedKey = '';

  function setStatus(next, detail = {}) {
    status = { ...status, ...next, ...detail };
    const key = `${status.state}|${status.message}|${status.setName}`;
    if (status.state === 'error' && key !== lastNotifiedKey) {
      lastNotifiedKey = key;
      try { notify(status.message, true); } catch {}
    }
    return status;
  }

  function getStatus() {
    return { ...status };
  }

  function readInstallState() {
    try { return normalizeQuickReplyInstallState(readState()); } catch { return defaultQuickReplyInstallState(); }
  }

  function writeInstallState(state) {
    try {
      writeState(normalizeQuickReplyInstallState(state));
      return true;
    } catch (error) {
      setStatus({ state: 'error', message: `保存 Quick Reply 安装标记失败：${error?.message || error}` });
      return false;
    }
  }

  function ensureButton(api, setName, state, force = false) {
    let existing = ownQrs(api, setName);
    if (!existing.length) {
      // The user may have edited the title/label. In an already-persisted own
      // set, the exact command message still identifies the button without
      // replacing or duplicating it.
      existing = listQuickReplies(api, setName).filter(label => {
        try {
          const qr = api.getQrByLabel(setName, label);
          return qr && qr.message === qrMessage();
        } catch { return false; }
      });
    }
    if (existing.length > 1) {
      setStatus({
        state: 'duplicate',
        message: `Quick Reply 组「${setName}」中存在多个本扩展按钮；未自动删除，请手动整理。`,
        setName,
      });
      return { ok: true, existing: true, duplicate: true };
    }
    if (existing.length === 1) {
      return {
        ok: true,
        existing: true,
        qr: api.getQrByLabel(setName, existing[0]),
        label: existing[0],
      };
    }
    if (state.completed && !force) {
      setStatus({
        state: 'removed',
        message: '修复按钮已被移除；已停止自动重装。可在主面板点击“恢复修复按钮”重新安装。',
        setName,
      });
      return { ok: true, removed: true };
    }
    const { label: _descriptorLabel, ...buttonProps } = QUICK_REPLY_SHAPE.button;
    const qr = api.createQuickReply(setName, state.label || QUICK_REPLY_ITEM_LABEL, buttonProps);
    const saved = typeof api.getSetByName === 'function' ? api.getSetByName(setName) : null;
    const savePromise = saved?.save?.();
    setStatus({ state: 'pending', message: '正在保存修复按钮…', setName });
    return { ok: true, created: true, qr, savePromise, label: state.label || QUICK_REPLY_ITEM_LABEL };
  }

  async function install({ force = false } = {}) {
    const api = getApi();
    if (!api) {
      setStatus({ state: 'unavailable', message: 'Quick Reply API 尚未就绪；未安装按钮，稍后会自动重试或可手动重试。' });
      return getStatus();
    }
    if (!apiReady(api)) {
      setStatus({ state: 'unavailable', message: 'Quick Reply API 缺少预期的公开方法；未安装按钮。' });
      return getStatus();
    }
    const command = getCommandReady();
    if (command && command.ok === false) {
      setStatus({
        state: command.state === 'collision' ? 'collision' : 'unavailable',
        message: command.reason || '斜杠命令不可用；已跳过 Quick Reply 安装。',
      });
      return getStatus();
    }
    if (api.settings && api.settings.isEnabled === false) {
      setStatus({ state: 'disabled', message: 'Quick Reply 扩展当前处于禁用状态；未启用也未安装按钮。' });
      return getStatus();
    }
    if (!ownerReady(api)) {
      setStatus({ state: 'unavailable', message: 'Quick Reply API 未提供创建能力；未安装按钮。' });
      return getStatus();
    }

    const state = readInstallState();
    const label = state.label || QUICK_REPLY_ITEM_LABEL;
    let setName = ownedSetName(api, state.setName, label);
    if (!setName && state.setName) {
      let persistedSet = null;
      try { persistedSet = api.getSetByName(state.setName); } catch {}
      // A persisted group name is ownership evidence for an explicit restore
      // or for completing a partial first install. Automatic startup never
      // claims an arbitrary group after a completed install.
      if (persistedSet && (force || !state.completed)) setName = state.setName;
    }
    if (!setName) {
      if (state.completed && !force) {
        setStatus({
          state: 'removed',
          message: '之前安装的 Quick Reply 组或按钮已被移除；已停止自动重装。可在主面板点击“恢复修复按钮”。',
        });
        return getStatus();
      }
      setName = chooseUniqueSetName(api, state.setName || QUICK_REPLY_SET_BASE, label);
      if (!setName) {
        setStatus({ state: 'error', message: '无法找到不冲突的 Quick Reply 组名；未覆盖任何现有组。' });
        return getStatus();
      }
    }

    let set = null;
    try { set = api.getSetByName(setName); } catch {}
    if (!set) {
      try {
        set = await api.createSet(setName, {
          disableSend: false,
          injectInput: false,
          placeBeforeInput: false,
        });
      } catch (error) {
        setStatus({ state: 'error', message: `创建 Quick Reply 组失败：${error?.message || error}` });
        return getStatus();
      }
    }
    if (!set) {
      setStatus({ state: 'error', message: '创建 Quick Reply 组失败；未覆盖现有组。' });
      return getStatus();
    }

    const result = ensureButton(api, setName, { ...state, label }, force);
    if (result.removed || result.duplicate) return getStatus();
    if (!result.ok) return getStatus();
    if (result.savePromise) {
      try { await result.savePromise; } catch (error) {
        setStatus({ state: 'error', message: `保存 Quick Reply 组失败：${error?.message || error}` });
        return getStatus();
      }
    }

    let activated = state.activated;
    let activationError = null;
    const shouldActivate = force || !state.activated;
    if (shouldActivate) {
      if (!setHasOurGlobal(api, setName)) {
        try { api.addGlobalSet(setName, true); } catch (error) { activationError = error; }
      }
      if (!activationError) activated = true;
    }
    if (activationError) {
      writeInstallState({ ...state, completed: true, setName, label: result.label || label, activated: false });
      setStatus({
        state: 'error',
        message: `修复按钮已创建，但激活 Quick Reply 组失败：${activationError?.message || activationError}。可重试。`,
        setName,
      });
      return getStatus();
    }
    if (!writeInstallState({ ...state, completed: true, setName, label: result.label || label, activated })) {
      return getStatus();
    }
    setStatus({
      state: 'installed',
      message: result.created || force ? '修复按钮已安装。' : '修复按钮已安装并保留现有用户设置。',
      setName,
    });
    return getStatus();
  }

  function ensureInstalled(options = {}) {
    const task = pending.then(() => install(options));
    pending = task.catch(error => {
      setStatus({ state: 'error', message: `Quick Reply 安装失败：${error?.message || error}` });
      return getStatus();
    });
    return pending;
  }

  function restore() {
    return ensureInstalled({ force: true });
  }

  return { ensureInstalled, restore, getStatus };
}

/**
 * Bounded late-readiness retries. API absence is retried a limited number of
 * times and APP_READY/panel-open checks remain available; no permanent interval.
 */
export function startQuickReplyReadiness({
  installer,
  eventSource = null,
  eventTypes = null,
  maxAttempts = 20,
  retryDelayMs = 1000,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  onStatus = () => {},
} = {}) {
  let attempts = 0;
  let disposed = false;
  let timerStopped = false;
  let inFlight = false;
  let timer = null;
  let pending = Promise.resolve();

  const update = status => {
    try { onStatus(status); } catch {}
  };

  const clearTimer = () => {
    if (timer && clearTimeoutFn) clearTimeoutFn(timer);
    timer = null;
  };

  const stopTimer = () => {
    timerStopped = true;
    clearTimer();
  };

  const stop = () => {
    disposed = true;
    timerStopped = true;
    clearTimer();
    if (eventSource && eventTypes?.APP_READY && typeof eventSource.removeListener === 'function') {
      eventSource.removeListener(eventTypes.APP_READY, onReady);
    }
  };

  const schedule = () => {
    if (disposed || timerStopped || !setTimeoutFn) return;
    clearTimer();
    timer = setTimeoutFn(attempt, retryDelayMs);
  };

  const finish = status => {
    update(status);
    if (!status) return schedule();
    if (['installed', 'removed', 'collision', 'duplicate'].includes(status.state)) {
      stopTimer();
      return;
    }
    attempts++;
    if (attempts >= maxAttempts) {
      // Bounded timers stop here, but the APP_READY listener remains active so
      // a later host-ready event can still perform an explicit idempotent check.
      stopTimer();
      return;
    }
    schedule();
  };

  const attempt = () => {
    if (disposed || !installer) return Promise.resolve();
    if (inFlight) return pending;
    inFlight = true;
    clearTimer();
    pending = Promise.resolve(installer.ensureInstalled())
      .then(status => finish(status))
      .catch(() => finish(undefined))
      .finally(() => { inFlight = false; });
    return pending;
  };

  const onReady = () => { void attempt(); };
  if (eventSource && eventTypes?.APP_READY && typeof eventSource.on === 'function') {
    eventSource.on(eventTypes.APP_READY, onReady);
  }
  void attempt();

  return {
    attempt,
    stop,
    wait: () => pending,
    getAttempts: () => attempts,
    isStopped: () => timerStopped && !inFlight,
  };
}

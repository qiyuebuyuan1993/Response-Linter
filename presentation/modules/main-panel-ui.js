// One shared main-settings DOM. The extension drawer and wand menu only hold
// small launchers; the full form lives in a dedicated accessible overlay.
function isModalVisible() {
  try {
    const selectors = [
      '.rl-modal',
      'dialog.popup[open]',
      '.popup[open]',
      '#dialogue_popup:not([hidden])',
      '.dialogue_popup:not([hidden])',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
    return candidates.some(element => {
      const style = window.getComputedStyle?.(element);
      if (!style) return !element.hidden;
      return style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden;
    });
  } catch {
    return false;
  }
}

function drawerLauncherHtml() {
  return `
    <div class="rl-drawer-launcher" data-rl-launcher="drawer">
      <div class="rl-drawer-launcher-text">
        <b>响应检查器</b>
        <small id="rl-drawer-status">打开主面板以配置规则与结构档案</small>
      </div>
      <button id="rl-open-main-panel" class="menu_button secondary small" type="button">
        <i class="fa-solid fa-wrench"></i> 打开设置
      </button>
    </div>
  `;
}

function wandLauncherHtml() {
  return `
    <div id="rl_wand_container" class="extension_container">
      <div id="rl-wand-button" class="extensionsMenuExtensionButton menu_button" role="button" tabindex="0"
        title="响应检查器：规则、结构档案与修复" aria-label="打开响应检查器设置">
        <i class="fa-solid fa-wrench"></i> 响应检查器
      </div>
    </div>
  `;
}

export function installWandLauncher({ attempts = 1, delayMs = 250, setTimeoutFn = globalThis.setTimeout?.bind(globalThis) } = {}) {
  const install = () => {
    if (document.getElementById('rl-wand-button')) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    const template = document.createElement('template');
    template.innerHTML = wandLauncherHtml().trim();
    const container = template.content.firstElementChild;
    if (container) menu.appendChild(container);
    return true;
  };
  if (install()) return true;
  if (attempts <= 1 || !setTimeoutFn) return false;
  let remaining = attempts - 1;
  const retry = () => {
    if (install()) return;
    remaining--;
    if (remaining > 0) setTimeoutFn(retry, delayMs);
  };
  setTimeoutFn(retry, delayMs);
  return false;
}

export function installDrawerLauncher(target) {
  if (!target || typeof target.appendChild !== 'function') return false;
  if (document.getElementById('rl-open-main-panel')) return true;
  const template = document.createElement('template');
  template.innerHTML = drawerLauncherHtml().trim();
  const element = template.content.firstElementChild;
  if (!element) return false;
  target.appendChild(element);
  return true;
}

/**
 * @param {Object} options
 * @param {string} options.settingsHtml rendered settings template
 * @param {Function} options.onOpen
 * @param {Function} options.onClose
 * @param {Function} options.onQrRestore
 * @param {Function} options.onStatusText
 */
export function setupMainPanel({
  settingsHtml,
  onOpen = () => {},
  onClose = () => {},
  onQrRestore = () => {},
  onStatusText = () => '响应检查器',
} = {}) {
  let overlay = document.getElementById('rl-main-panel');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'rl-main-panel';
    overlay.className = 'rl-main-panel-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rl-main-panel-title');
    overlay.innerHTML = `
      <div class="rl-main-panel">
        <div class="rl-main-panel-header">
          <h3 id="rl-main-panel-title">响应检查器</h3>
          <span id="rl-status-indicator" class="rl-status-indicator active" title="扩展状态">●</span>
          <span id="rl-main-panel-status" class="rl-help-text"></span>
          <span class="rl-main-panel-spacer"></span>
          <button id="rl-close-main-panel" class="menu_button secondary rl-main-panel-close" type="button" aria-label="关闭设置">×</button>
        </div>
        <div id="rl-main-panel-body" class="rl-main-panel-body"></div>
      </div>
    `;
    const body = overlay.querySelector('#rl-main-panel-body');
    if (body) body.innerHTML = settingsHtml || '';
    document.body.appendChild(overlay);
  }

  let lastFocus = null;
  const open = () => {
    if (!overlay.hidden) return;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add('rl-main-panel-open');
    try {
      onOpen();
      const status = overlay.querySelector('#rl-main-panel-status');
      if (status) status.textContent = onStatusText();
      const focusTarget = overlay.querySelector('#rl-profile-select')
        || overlay.querySelector('#rl-close-main-panel')
        || overlay.querySelector('button');
      focusTarget?.focus?.();
    } catch (error) {
      console.warn('[Response Linter] open main panel callback failed', error);
    }
  };

  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('rl-main-panel-open');
    try { onClose(); } catch {}
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch {}
    }
  };

  const bind = (selector, event, handler) => {
    const target = overlay.querySelector(selector) || document.querySelector(selector);
    if (!target || target.__rlMainPanelBound === true) return;
    target.__rlMainPanelBound = true;
    target.addEventListener(event, handler);
  };

  bind('#rl-close-main-panel', 'click', close);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', event => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      if (isModalVisible()) return;
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(overlay.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(element => element.offsetParent !== null || element.getClientRects?.().length);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const qrButton = document.getElementById('rl-qr-install');
  if (qrButton && qrButton.__rlMainPanelBound !== true) {
    qrButton.__rlMainPanelBound = true;
    qrButton.addEventListener('click', () => onQrRestore());
  }

  // Delegated launcher handling works even when the wand menu (or a late
  // host-created container) appears after this module initialized.
  if (document.__rlMainPanelLaunchDelegated !== true) {
    document.__rlMainPanelLaunchDelegated = true;
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('#rl-open-main-panel, #rl-wand-button');
      if (!target) return;
      event.preventDefault();
      open();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target?.closest?.('#rl-open-main-panel, #rl-wand-button');
      if (!target) return;
      event.preventDefault();
      open();
    });
  }

  return {
    overlay,
    open,
    close,
    isOpen: () => !overlay.hidden,
    setStatus: text => {
      const status = overlay.querySelector('#rl-main-panel-status');
      if (status) status.textContent = text || '';
      const drawerStatus = document.getElementById('rl-drawer-status');
      if (drawerStatus) drawerStatus.textContent = text || '';
    },
  };
}

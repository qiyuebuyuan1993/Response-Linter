// Slash-command bridge for the bundled Quick Reply button.
// Registration is explicit and idempotent; an unrelated command with the same
// name is never overridden.

export const RESPONSE_LINTER_COMMAND_NAME = 'response-linter-fix';
export const RESPONSE_LINTER_COMMAND_VERSION = 1;

function escapeForToast(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notifyError(toastr, error) {
  const message = escapeForToast(error?.message || error || '未知错误');
  try {
    if (toastr?.error) toastr.error(message, '响应检查器', { timeOut: 7000, escapeHtml: false });
  } catch {}
}

/**
 * Register the slash command before the Quick Reply installer imports/creates
 * its set. The callback only calls the same latest-AI manual repair action; it
 * never sends a user/AI message and never generates a reply.
 */
export function registerQuickReplyCommand({ ctx = {}, runRepair, toastr = null } = {}) {
  const parser = ctx?.SlashCommandParser;
  const commandClass = ctx?.SlashCommand;
  if (!parser || typeof parser.addCommandObject !== 'function' || !commandClass || typeof commandClass.fromProps !== 'function') {
    return { ok: false, state: 'unavailable', reason: '宿主尚未暴露 SlashCommandParser / SlashCommand' };
  }
  const commands = parser.commands && typeof parser.commands === 'object' ? parser.commands : {};
  if (Object.prototype.hasOwnProperty.call(commands, RESPONSE_LINTER_COMMAND_NAME)) {
    const existing = commands[RESPONSE_LINTER_COMMAND_NAME];
    if (existing?.__responseLinterOwned === true) {
      return { ok: true, state: 'reused', command: existing };
    }
    return {
      ok: false,
      state: 'collision',
      reason: `斜杠命令 /${RESPONSE_LINTER_COMMAND_NAME} 已被其他扩展占用，已跳过 Quick Reply 安装。`,
    };
  }
  if (typeof runRepair !== 'function') {
    return { ok: false, state: 'unavailable', reason: '修复回调不可用' };
  }

  const callback = async () => {
    try {
      const result = await runRepair();
      if (result && result.success === false && !result.requiresConfirmation) {
        notifyError(toastr, result.reason || '修复失败');
      }
    } catch (error) {
      notifyError(toastr, error);
    }
    // Always empty: the QR must not insert text or send a chat message.
    return '';
  };
  const command = commandClass.fromProps({
    name: RESPONSE_LINTER_COMMAND_NAME,
    aliases: [],
    helpString: '运行“响应检查器”的手动修复（最新 AI 回复；不会发送消息或生成回复）。',
    callback,
    unnamedArgumentList: [],
    splitUnnamedArgument: false,
    returns: '',
  });
  command.__responseLinterOwned = true;
  command.__responseLinterCommandVersion = RESPONSE_LINTER_COMMAND_VERSION;
  try {
    parser.addCommandObject(command);
    return { ok: true, state: 'registered', command };
  } catch (error) {
    return { ok: false, state: 'error', reason: error?.message || String(error) };
  }
}

export function hasOwnedQuickReplyCommand(ctx = {}) {
  const command = ctx?.SlashCommandParser?.commands?.[RESPONSE_LINTER_COMMAND_NAME];
  return !!command && command.__responseLinterOwned === true;
}

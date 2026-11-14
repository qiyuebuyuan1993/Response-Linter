// Bundled Quick Reply descriptor. This is the runtime source of truth for the
// set/button shape; presentation/quick-reply/response-linter-fix.qr.json is the
// equivalent public descriptor for inspection/export.
import {
  RESPONSE_LINTER_COMMAND_NAME,
  RESPONSE_LINTER_COMMAND_VERSION,
} from './quick-reply-command.js';

export const QUICK_REPLY_DESCRIPTOR_VERSION = 1;
export const QUICK_REPLY_SET_BASE = 'Response Linter';
export const QUICK_REPLY_ITEM_LABEL = '修复最新回复';
export const QUICK_REPLY_ITEM_TITLE_MARKER = '[response-linter-qr]';

export function quickReplyDescriptor() {
  return {
    format: 'response-linter-quick-reply-descriptor',
    version: QUICK_REPLY_DESCRIPTOR_VERSION,
    command: {
      name: RESPONSE_LINTER_COMMAND_NAME,
      version: RESPONSE_LINTER_COMMAND_VERSION,
    },
    set: {
      baseName: QUICK_REPLY_SET_BASE,
      disableSend: false,
      injectInput: false,
      placeBeforeInput: false,
      activateOnFirstInstall: true,
      visible: true,
    },
    button: {
      label: QUICK_REPLY_ITEM_LABEL,
      title: `${QUICK_REPLY_ITEM_TITLE_MARKER} 修复最新 AI 回复（/${RESPONSE_LINTER_COMMAND_NAME}）`,
      message: `/${RESPONSE_LINTER_COMMAND_NAME}`,
      showLabel: true,
      isHidden: false,
      executeOnStartup: false,
      executeOnUser: false,
      executeOnAi: false,
      executeOnChatChange: false,
      executeOnGroupMemberDraft: false,
      executeOnNewChat: false,
      executeBeforeGeneration: false,
      automationId: '',
    },
  };
}

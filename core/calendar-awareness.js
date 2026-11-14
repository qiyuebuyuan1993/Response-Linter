// Read-only calendar awareness for the settings UI.
// Explicit preset/custom selections are never replaced by automatic Gouhua
// recognition; Gouhua data is only read through the existing calendar engine.
import {
  CALENDAR_SOURCE_LABELS,
  describeCalendar,
  readGouhuaCalendar,
  resolveCalendarSource,
} from './calendar-engine.js';
import { readFeatureSettings } from './feature-settings.js';
import { readStructureProfiles } from './structure-profiles.js';

export const GOUHUA_CALENDAR_CHANGED_EVENT = 'st-sevendayscal:calendar-changed';

export function isAutomaticCalendarSource(source) {
  return String(source ?? '').trim().toLowerCase() === 'gouhua';
}

/**
 * Resolve a human-readable calendar status. This function is read-only and
 * returns a fresh result on every call, so chat switches and Gouhua changes are
 * reflected without caching. Time mode none deliberately reports no calendar.
 */
export function resolveCalendarAwareness(settings = {}, ctx = null) {
  const feature = readFeatureSettings(settings);
  const profile = readStructureProfiles(settings).activeProfile;
  if (profile?.time?.mode === 'none') {
    return {
      ok: true,
      required: false,
      source: 'none',
      sourceLabel: '无时间标记',
      message: '当前结构配置不使用时间标记，无需历法。',
      automatic: false,
    };
  }
  const source = feature.sdcCalendarSource;
  if (!isAutomaticCalendarSource(source)) {
    const result = resolveCalendarSource({
      source,
      customJson: feature.sdcCustomCalendarJson,
      ctx,
    });
    return {
      ...result,
      required: true,
      automatic: false,
      message: result.ok
        ? `${result.sourceLabel}：${describeCalendar(result.calendar)}`
        : `${result.sourceLabel || CALENDAR_SOURCE_LABELS[source] || source}：${result.error}`,
    };
  }
  const result = readGouhuaCalendar(ctx);
  return {
    ...result,
    required: true,
    automatic: true,
    message: result.ok
      ? `构画 / 当前聊天：${describeCalendar(result.calendar)}`
      : `构画 / 当前聊天：${result.error}`,
  };
}

/**
 * Track the host's Gouhua calendar-change event and chat changes with the same
 * callback. The returned cleanup function is idempotent.
 */
export function watchCalendarAwareness({
  eventSource = null,
  eventTypes = null,
  onChanged = () => {},
  windowObject = typeof window !== 'undefined' ? window : null,
} = {}) {
  let disposed = false;
  const notify = () => {
    if (!disposed) {
      try { onChanged(); } catch {}
    }
  };
  const onWindowCalendarChanged = () => notify();
  if (windowObject && typeof windowObject.addEventListener === 'function') {
    windowObject.addEventListener(GOUHUA_CALENDAR_CHANGED_EVENT, onWindowCalendarChanged);
  }
  const onChatChanged = () => notify();
  const chatEvent = eventTypes?.CHAT_CHANGED;
  if (eventSource && chatEvent && typeof eventSource.on === 'function') {
    eventSource.on(chatEvent, onChatChanged);
  }
  return function stop() {
    if (disposed) return;
    disposed = true;
    if (windowObject && typeof windowObject.removeEventListener === 'function') {
      windowObject.removeEventListener(GOUHUA_CALENDAR_CHANGED_EVENT, onWindowCalendarChanged);
    }
    if (eventSource && chatEvent && typeof eventSource.removeListener === 'function') {
      eventSource.removeListener(chatEvent, onChatChanged);
    }
  };
}

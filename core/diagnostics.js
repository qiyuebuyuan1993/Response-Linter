// Response Linter 1.4.13 privacy-safe diagnostics.
//
// This module is deliberately self-contained and memory-only. It accepts no
// messages, chat identifiers, URLs, configuration objects, or free-form error
// text. Unknown events and fields are discarded, and exported records are
// detached copies of the in-memory ring.

const SCHEMA_VERSION = 1;
const CAPACITY = 200;

const ALLOWED_EVENTS = new Set([
  'host.swipe',
  'host.chat_changed',
  'host.generation_started',
  'host.generation_ended',
  'host.message_updated',
  'preview.created',
  'preview.invalidated',
  'preview.confirmed',
  'preview.rejected',
  'repair.queued',
  'repair.started',
  'repair.finished',
  'write.started',
  'write.finished',
  'diagnostics.cleared',
]);

const ALLOWED_OWNERS = new Set([
  'response-linter',
  'veridis-rewrite',
  'veridis-save',
  'none',
  'unknown',
]);

const SAFE_CODE_RE = /^[a-z0-9_.-]{1,64}$/;

// Field order is the documented public order. Only these property names are
// ever read from the caller-supplied fields object.
const FIELD_RULES = Object.freeze([
  ['messageIndex', 'number'],
  ['swipeId', 'number'],
  ['queueLength', 'number'],
  ['pendingCount', 'number'],
  ['epoch', 'number'],
  ['durationMs', 'number'],
  ['rawLength', 'number'],
  ['displayLength', 'number'],
  ['enabled', 'boolean'],
  ['autoFix', 'boolean'],
  ['streaming', 'boolean'],
  ['success', 'boolean'],
  ['conflict', 'boolean'],
  ['rollbackSkipped', 'boolean'],
  ['reason', 'safe-code'],
  ['owner', 'owner'],
]);

const ring = new Array(CAPACITY);
let start = 0;
let count = 0;
let nextSeq = 1;

function sanitizeFields(fields) {
  const safeFields = Object.create(null);
  if (fields === null || typeof fields !== 'object') return safeFields;

  for (const [name, kind] of FIELD_RULES) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(fields, name);
    } catch {
      // Hostile proxies must not break diagnostics. Never inspect or log the
      // thrown value; simply skip this optional field.
      continue;
    }

    // Inherited fields and accessors are ignored so merely recording a
    // diagnostic cannot invoke arbitrary getters or expose inherited data.
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
    const value = descriptor.value;

    if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) safeFields[name] = value;
    } else if (kind === 'boolean') {
      if (typeof value === 'boolean') safeFields[name] = value;
    } else if (kind === 'safe-code') {
      if (typeof value === 'string') {
        // Require the match to span the whole value. JavaScript's `$` also
        // matches before a trailing line terminator, which is not a safe code.
        const match = SAFE_CODE_RE.exec(value);
        if (match && match[0] === value) safeFields[name] = value;
      }
    } else if (kind === 'owner') {
      if (typeof value === 'string' && ALLOWED_OWNERS.has(value)) safeFields[name] = value;
    }
  }

  return safeFields;
}

/**
 * Record one allowlisted lifecycle/UI event.
 *
 * @param {string} event allowlisted event name
 * @param {object} [fields] optional allowlisted safe fields
 * @returns {boolean} true when the event was recorded, false when ignored
 */
export function recordDiagnostic(event, fields = {}) {
  if (typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) return false;

  let at;
  try {
    at = new Date().toISOString();
  } catch {
    // Date is a local, dependency-free clock in supported hosts. If a hostile
    // environment breaks it, fail closed rather than fabricate a timestamp.
    return false;
  }

  const safeFields = sanitizeFields(fields);
  const record = Object.freeze({
    seq: nextSeq,
    at,
    event,
    ...safeFields,
  });

  if (count === CAPACITY) {
    ring[start] = record;
    start = (start + 1) % CAPACITY;
  } else {
    ring[(start + count) % CAPACITY] = record;
    count += 1;
  }
  nextSeq += 1;
  return true;
}

/**
 * Return a detached snapshot of the current ring.
 * Mutating the result cannot alter stored diagnostics.
 */
export function getDiagnostics() {
  const records = [];
  for (let offset = 0; offset < count; offset += 1) {
    const record = ring[(start + offset) % CAPACITY];
    records.push({ ...record });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    capacity: CAPACITY,
    records,
  };
}

/**
 * Clear all stored records. The monotonic sequence counter is intentionally
 * retained so records before and after a clear remain distinguishable.
 */
export function clearDiagnostics() {
  ring.fill(undefined);
  start = 0;
  count = 0;
}

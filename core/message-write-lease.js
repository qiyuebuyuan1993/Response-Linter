import { getMessageWriteCoordinator } from './messageWriteCoordinator.js';

const leases = new WeakSet();
export function ownsWriteLease(lease, chat) {
  return !!lease && leases.has(lease) && lease.chat === chat &&
    getMessageWriteCoordinator().isOwner(chat, 'response-linter');
}
export function withMessageWriteLease(chat, task) {
  return getMessageWriteCoordinator().run(chat, 'response-linter', async () => {
    const lease = Object.freeze({ chat });
    leases.add(lease);
    try { return await task(lease); } finally { leases.delete(lease); }
  });
}

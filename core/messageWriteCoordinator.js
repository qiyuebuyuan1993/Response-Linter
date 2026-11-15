// Shared by cooperating extensions. The host chat array is the identity, never a message index.
const key = Symbol.for('st.message-write-coordinator.v1');

export function getMessageWriteCoordinator() {
    const existing = globalThis[key];
    if (existing) {
        if (existing.version !== 1 || typeof existing.run !== 'function' || typeof existing.isOwner !== 'function') {
            throw new Error('Incompatible message write coordinator');
        }
        return existing;
    }
    const chats = new WeakMap();
    const coordinator = Object.freeze({
        version: 1,
        isOwner(chat, owner) { return chats.get(chat)?.owner === owner; },
        run(chat, owner, task) {
            if (!Array.isArray(chat) || typeof task !== 'function' || !owner) {
                return Promise.reject(new TypeError('A chat array, owner and task are required'));
            }
            let state = chats.get(chat);
            if (!state) { state = { owner: null, queue: [] }; chats.set(chat, state); }
            return new Promise((resolve, reject) => {
                const start = () => {
                    state.owner = owner;
                    let result;
                    try { result = task(); } catch (error) { result = Promise.reject(error); }
                    Promise.resolve(result).then(resolve, reject).finally(() => {
                        state.owner = null;
                        const next = state.queue.shift();
                        if (next) next();
                        else chats.delete(chat);
                    });
                };
                if (state.owner !== null) state.queue.push(start);
                else start();
            });
        },
    });
    globalThis[key] = coordinator;
    return coordinator;
}

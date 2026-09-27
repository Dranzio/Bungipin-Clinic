// LOGIN ATTEMPT SECURITY
const MAX_FAILURES = 3;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const attempts = new Map();

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function getState(email) {
    const key = normalizeEmail(email);
    const state = attempts.get(key);

    if (!state) return null;
    if (state.lockedUntil <= Date.now()) {
        attempts.delete(key);
        return null;
    }

    return state;
}

function isLocked(email) {
    const state = getState(email);
    return state && state.failures >= MAX_FAILURES;
}

function recordFailure(email) {
    const key = normalizeEmail(email);
    const state = getState(key) || { failures: 0, lockedUntil: 0 };
    state.failures += 1;

    if (state.failures >= MAX_FAILURES) {
        state.lockedUntil = Date.now() + LOCK_DURATION_MS;
    }

    attempts.set(key, state);
    return state;
}

function clear(email) {
    attempts.delete(normalizeEmail(email));
}

module.exports = {
    isLocked,
    recordFailure,
    clear
};

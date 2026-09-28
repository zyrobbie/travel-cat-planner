// Shared identity for the two GitHub Pages UI previews. This key is separate
// from the formal /app/ IndexedDB data and makes no account or cloud claim.
export const PREVIEW_IDENTITY_KEY = 'cat-letters-e3-g2r:confirmed-cat-v1';
const CAT_IDS = new Set(['cat-01', 'cat-02', 'cat-03', 'cat-04']);
const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });

export function validIdentity(value) {
  return !!value && CAT_IDS.has(value.catId) && typeof value.name === 'string'
    && value.name.trim() === value.name && value.name.length > 0
    && Array.from(segments.segment(value.name)).length <= 12;
}

export function readPreviewIdentity(storage) {
  try {
    const adapter = storage ?? globalThis.localStorage;
    const raw = adapter.getItem(PREVIEW_IDENTITY_KEY);
    if (raw === null) return { ok: true, identity: null };
    const record = JSON.parse(raw);
    if (record?.version !== 1 || !validIdentity(record)) throw Error('INVALID_IDENTITY');
    return { ok: true, identity: { catId: record.catId, name: record.name } };
  } catch (error) {
    return { ok: false, error: error.message || 'IDENTITY_READ_ERROR' };
  }
}

export async function confirmPreviewIdentity(identity, storage, lockManager = globalThis.navigator?.locks) {
  if (!validIdentity(identity)) return { ok: false, error: 'INVALID_IDENTITY' };
  if (!lockManager || typeof lockManager.request !== 'function') {
    return { ok: false, error: 'LOCK_UNAVAILABLE' };
  }
  try {
    return await lockManager.request(PREVIEW_IDENTITY_KEY, { mode: 'exclusive' }, async () => {
      const before = readPreviewIdentity(storage);
      if (!before.ok) return before;
      if (before.identity) {
        return before.identity.catId === identity.catId && before.identity.name === identity.name
          ? { ok: true, identity: before.identity, reused: true }
          : { ok: false, error: 'ALREADY_CONFIRMED', identity: before.identity };
      }
      try {
        const adapter = storage ?? globalThis.localStorage;
        adapter.setItem(PREVIEW_IDENTITY_KEY, JSON.stringify({ version: 1, ...identity }));
        const after = readPreviewIdentity(adapter);
        if (!after.ok || after.identity?.catId !== identity.catId || after.identity?.name !== identity.name) {
          return { ok: false, error: 'IDENTITY_WRITE_ERROR' };
        }
        return { ok: true, identity: after.identity, reused: false };
      } catch (error) {
        return { ok: false, error: error.message || 'IDENTITY_WRITE_ERROR' };
      }
    });
  } catch (error) {
    return { ok: false, error: error.message || 'LOCK_ERROR' };
  }
}

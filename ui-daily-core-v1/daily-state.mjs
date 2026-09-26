// Pure model for the local E/G/H/F preview. No browser, clock or storage effects.
export const MAX_REPLY_LENGTH = 2000;
const APPEARANCES = ['cat-01', 'cat-02', 'cat-03', 'cat-04'];
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const clone = value => structuredClone(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
export const LETTER_FIXTURES = Object.freeze({
  'need-01': Object.freeze({ id: 'need-01', type: 'NEED_CARD', date: '2026-09-26', title: '阳光会在这里等我吗？', data: {} }),
  'need-02': Object.freeze({ id: 'need-02', type: 'NEED_CARD', date: '2026-09-27', title: '可以陪我听一会儿雨吗？', data: {} }),
  'postcard-01': Object.freeze({ id: 'postcard-01', type: 'POSTCARD', date: '2026-09-28', title: '远方来了一封信！', data: {} }),
});

function makeLetter(letter) {
  if (!letter || !validId(letter.id) || !['NEED_CARD', 'POSTCARD'].includes(letter.type)) return null;
  return {
    id: letter.id, type: letter.type, date: String(letter.date || ''), title: String(letter.title || ''),
    data: clone(letter.data || {}), readState: 'UNREAD', draft: '', draftRevision: 0, savedRevision: -1,
    draftSaveState: 'IDLE', replySubmitState: 'IDLE', checkState: 'IDLE',
    pendingSave: null, pendingSubmission: null, receiptId: null, submittedText: null,
  };
}

export function initialState(options = {}) {
  const appearanceId = APPEARANCES.includes(options.appearanceId) ? options.appearanceId
    : APPEARANCES.includes(options.catId) ? options.catId : 'cat-01';
  const first = makeLetter(has(options, 'initialLetter') ? options.initialLetter : LETTER_FIXTURES['need-01']);
  const catState = options.catState === 'TRIP' ? 'TRIP' : 'HOME';
  return {
    schemaVersion: 1, revision: 0, operationSeq: 0,
    catId: validId(options.catId) ? options.catId : 'cat-01', appearanceId,
    catName: typeof options.catName === 'string' && options.catName.trim() ? options.catName.trim() : '小咪',
    catState, page: catState === 'TRIP' ? 'F' : 'E',
    newLetterId: first?.id || null, letters: first ? { [first.id]: first } : {}, currentLetterId: null,
    draftSaveState: 'IDLE', replySubmitState: 'IDLE', checkState: 'IDLE',
    pendingSave: null, pendingSubmission: null, submissionRecoveryRequired: false,
    refreshError: false, loadError: false,
  };
}

export const currentLetter = state => has(state.letters, state.currentLetterId) ? state.letters[state.currentLetterId] : null;
export const homePage = state => state.catState === 'TRIP' ? 'F' : 'E';
export function getHomeEntry(state) {
  // The home entry never prefers a draft over unread mail or opens an editor.
  return state.newLetterId && has(state.letters, state.newLetterId) ? state.letters[state.newLetterId] : null;
}
export const countReply = value => Array.from(segmenter.segment(typeof value === 'string' ? value : '')).length;
export function validateReply(value) {
  if (typeof value !== 'string' || !value.trim()) return '写几句再送出去吧。';
  return countReply(value) > MAX_REPLY_LENGTH ? '回应最多 2000 个字哦。' : '';
}
export function canSubmit(state) {
  const letter = currentLetter(state);
  return state.page === 'G' && !!letter && letter.type === 'NEED_CARD'
    && !state.loadError && !state.submissionRecoveryRequired
    && !['SUBMITTING', 'SUCCESS'].includes(letter.replySubmitState)
    && letter.checkState !== 'SAFETY' && validateReply(letter.draft) === '';
}

function sync(state) {
  const letter = currentLetter(state);
  for (const key of ['draftSaveState', 'replySubmitState', 'checkState']) state[key] = letter?.[key] || 'IDLE';
  state.pendingSave = letter?.pendingSave ? clone(letter.pendingSave) : null;
  state.pendingSubmission = letter?.pendingSubmission ? clone(letter.pendingSubmission) : null;
  return state;
}
function locked(state) {
  return state.submissionRecoveryRequired || Object.values(state.letters).some(letter => letter.replySubmitState === 'SUBMITTING');
}
function matchesSave(letter, event) {
  return !!letter?.pendingSave && event.requestId === letter.pendingSave.requestId
    && event.revision === letter.pendingSave.revision && event.revision === letter.draftRevision;
}
function matchesSubmission(letter, event) {
  return letter?.replySubmitState === 'SUBMITTING' && !!letter.pendingSubmission
    && event.requestId === letter.pendingSubmission.requestId;
}

/**
 * OPEN_NEED {letterId}; NEW_LETTER {letter}; POSTCARD_READ {letterId};
 * EDIT {value}; BEGIN_SAVE {letterId?}; SAVE_SUCCESS/SAVE_ERROR {letterId,revision,requestId};
 * BEGIN_SUBMIT; SEND_SUCCESS/SEND_ERROR/CHECK_ERROR/SAFETY_BLOCKED/SUBMIT_UNKNOWN
 *   {letterId,requestId,receiptId?,text?}; BACK_HOME/SKIP; CAT_TRIP/CAT_HOME;
 * REFRESH_ERROR/REFRESH_SUCCESS; LOAD_ERROR/LOAD_SUCCESS.
 * Dispatch result events against the latest state, not the earlier captured state.
 */
export function transition(state, event = {}) {
  const next = clone(state);
  const id = event?.letterId || next.currentLetterId;
  const letter = has(next.letters, id) ? next.letters[id] : null;
  switch (event?.type) {
    case 'OPEN_NEED':
      if (!locked(next) && letter?.type === 'NEED_CARD') {
        letter.readState = 'READ';
        if (next.newLetterId === id) next.newLetterId = null;
        next.currentLetterId = id;
        next.page = letter.replySubmitState === 'SUCCESS' ? 'H' : 'G';
        next.refreshError = false;
      }
      break;
    case 'BACK_HOME':
    case 'SKIP':
      if (!locked(next)) { next.page = homePage(next); next.refreshError = false; }
      break;
    case 'NEW_LETTER': {
      const added = makeLetter(event.letter);
      if (!next.newLetterId && added && !has(next.letters, added.id)) {
        next.letters[added.id] = added;
        next.newLetterId = added.id;
      }
      break;
    }
    case 'POSTCARD_READ':
      if (letter?.type === 'POSTCARD') {
        letter.readState = 'READ';
        if (next.newLetterId === id) next.newLetterId = null;
      }
      break;
    case 'CAT_TRIP':
    case 'CAT_HOME':
      next.catState = event.type === 'CAT_TRIP' ? 'TRIP' : 'HOME';
      if (['E', 'F'].includes(next.page)) next.page = homePage(next);
      break;
    case 'EDIT':
      if (next.page === 'G' && letter?.type === 'NEED_CARD' && !locked(next)
        && letter.replySubmitState !== 'SUCCESS' && typeof event.value === 'string' && event.value !== letter.draft) {
        letter.draft = event.value; letter.draftRevision += 1;
        letter.draftSaveState = 'IDLE'; letter.pendingSave = null;
        letter.replySubmitState = 'IDLE'; letter.checkState = 'IDLE';
      }
      break;
    case 'BEGIN_SAVE':
      if (letter?.type === 'NEED_CARD' && letter.replySubmitState !== 'SUCCESS') {
        next.operationSeq += 1;
        letter.pendingSave = { letterId: id, revision: letter.draftRevision, requestId: `save-${id}-${next.operationSeq}` };
        letter.draftSaveState = 'SAVING';
      }
      break;
    case 'SAVE_SUCCESS':
    case 'SAVE_ERROR':
      if (matchesSave(letter, event)) {
        letter.draftSaveState = event.type === 'SAVE_SUCCESS' ? 'SAVED' : 'ERROR';
        if (event.type === 'SAVE_SUCCESS') letter.savedRevision = event.revision;
        letter.pendingSave = null;
      }
      break;
    case 'BEGIN_SUBMIT':
      if (canSubmit(next)) {
        next.operationSeq += 1;
        letter.pendingSubmission = { letterId: id, revision: letter.draftRevision,
          requestId: `reply-${id}-${next.operationSeq}`, text: letter.draft };
        letter.replySubmitState = 'SUBMITTING'; letter.checkState = 'IDLE';
        letter.pendingSave = null;
        if (letter.draftSaveState === 'SAVING') letter.draftSaveState = 'IDLE';
      }
      break;
    case 'SEND_SUCCESS':
      if (matchesSubmission(letter, event)) {
        letter.submittedText = typeof event.text === 'string' ? event.text : letter.pendingSubmission.text;
        letter.receiptId = event.receiptId || event.requestId;
        letter.replySubmitState = 'SUCCESS'; letter.checkState = 'IDLE';
        letter.draft = ''; letter.draftRevision += 1; letter.savedRevision = letter.draftRevision;
        letter.draftSaveState = 'IDLE'; letter.pendingSave = null; letter.pendingSubmission = null;
        next.submissionRecoveryRequired = false; next.refreshError = false; next.page = 'H';
      }
      break;
    case 'SEND_ERROR':
    case 'CHECK_ERROR':
    case 'SAFETY_BLOCKED':
      if (matchesSubmission(letter, event)) {
        letter.replySubmitState = event.type === 'SEND_ERROR' ? 'ERROR' : 'IDLE';
        letter.checkState = event.type === 'CHECK_ERROR' ? 'CHECK_ERROR' : event.type === 'SAFETY_BLOCKED' ? 'SAFETY' : 'IDLE';
        letter.pendingSubmission = null; next.submissionRecoveryRequired = false; next.page = 'G';
      }
      break;
    case 'SUBMIT_UNKNOWN':
      if (matchesSubmission(letter, event)) next.submissionRecoveryRequired = true;
      break;
    case 'REFRESH_ERROR': next.refreshError = true; break;
    case 'REFRESH_SUCCESS': next.refreshError = false; break;
    case 'LOAD_ERROR': next.loadError = true; break;
    case 'LOAD_SUCCESS': next.loadError = false; break;
  }
  sync(next);
  if (JSON.stringify(next) !== JSON.stringify(state)) next.revision = state.revision + 1;
  return next;
}

/** Storage validation: malformed local data must not silently create a new cat. */
export function validateSnapshot(state) {
  if (!state || state.schemaVersion !== 1 || !validId(state.catId) || !APPEARANCES.includes(state.appearanceId)
    || typeof state.catName !== 'string' || !state.catName.trim() || !['HOME', 'TRIP'].includes(state.catState)
    || !['E', 'F', 'G', 'H'].includes(state.page) || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.operationSeq) || state.operationSeq < 0
    || !state.letters || typeof state.letters !== 'object' || Array.isArray(state.letters)) return false;
  const letters = Object.entries(state.letters);
  for (const [id, letter] of letters) {
    if (!validId(id) || letter?.id !== id || !['NEED_CARD', 'POSTCARD'].includes(letter.type)
      || !['READ', 'UNREAD'].includes(letter.readState) || typeof letter.draft !== 'string'
      || !Number.isSafeInteger(letter.draftRevision) || letter.draftRevision < 0
      || !Number.isSafeInteger(letter.savedRevision) || letter.savedRevision < -1
      || !['IDLE', 'SAVING', 'SAVED', 'ERROR'].includes(letter.draftSaveState)
      || !['IDLE', 'SUBMITTING', 'SUCCESS', 'ERROR'].includes(letter.replySubmitState)
      || !['IDLE', 'CHECK_ERROR', 'SAFETY'].includes(letter.checkState)) return false;
    if (letter.replySubmitState === 'SUBMITTING' && (!letter.pendingSubmission
      || letter.pendingSubmission.letterId !== id || typeof letter.pendingSubmission.requestId !== 'string'
      || letter.pendingSubmission.revision !== letter.draftRevision || letter.pendingSubmission.text !== letter.draft)) return false;
    if (letter.replySubmitState === 'SUCCESS' && (typeof letter.receiptId !== 'string' || typeof letter.submittedText !== 'string')) return false;
  }
  const unread = letters.filter(([, letter]) => letter.readState === 'UNREAD');
  if (unread.length > 1 || (state.newLetterId === null ? unread.length !== 0
    : unread.length !== 1 || unread[0][0] !== state.newLetterId)) return false;
  if (state.currentLetterId !== null && !has(state.letters, state.currentLetterId)) return false;
  if (['G', 'H'].includes(state.page) && currentLetter(state)?.type !== 'NEED_CARD') return false;
  if (state.page === 'H' && currentLetter(state)?.replySubmitState !== 'SUCCESS') return false;
  return true;
}

/** Restore without auto-sending. Unread mail wins over reopening an old editor. */
export function restoreSnapshot(snapshot) {
  if (!validateSnapshot(snapshot)) throw new Error('INVALID_SNAPSHOT');
  const state = clone(snapshot);
  for (const letter of Object.values(state.letters)) {
    if (letter.draftSaveState === 'SAVING') { letter.draftSaveState = 'IDLE'; letter.pendingSave = null; }
  }
  state.submissionRecoveryRequired = Object.values(state.letters).some(letter => letter.replySubmitState === 'SUBMITTING');
  if (state.page === 'G' && state.newLetterId && !state.submissionRecoveryRequired) state.page = homePage(state);
  state.loadError = false; state.refreshError = false;
  return sync(state);
}

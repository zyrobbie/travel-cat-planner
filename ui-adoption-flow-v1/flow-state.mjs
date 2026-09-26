// Pure, in-memory state for the UI-01A–C prototype. No storage or DOM effects.
const CAT_IDS = new Set(['cat-01', 'cat-02', 'cat-03', 'cat-04']);
const nameSegments = new Intl.Segmenter('zh', { granularity: 'grapheme' });

const trimName = value => typeof value === 'string' ? value.trim() : '';
const hasCat = state => CAT_IDS.has(state.selectedCatId);
const isEditable = state =>
  state.adoptionStatus === 'UNCONFIRMED' || state.adoptionStatus === 'ERROR';

export function initialState() {
  return {
    step: 'A',
    selectedCatId: null,
    catNameDraft: '',
    adoptionStatus: 'UNCONFIRMED',
    confirmedCat: null,
  };
}

/** Count user-perceived characters, including combined emoji, after trimming. */
export function countName(value) {
  return Array.from(nameSegments.segment(trimName(value))).length;
}

export function validateName(value) {
  const length = countName(value);
  if (length === 0) return '先给小猫起个名字吧。';
  if (length > 12) return '名字最多 12 个字哦。';
  return '';
}

/** A: can go to B. B: can go to C. C: can begin confirmation. */
export function canContinue(state) {
  if (!isEditable(state) || !hasCat(state)) return false;
  if (state.step === 'A') return true;
  return (state.step === 'B' || state.step === 'C') &&
    validateName(state.catNameDraft) === '';
}

function readConfirmedCat(value) {
  if (!value || !CAT_IDS.has(value.catId) || validateName(value.name) !== '') {
    return null;
  }
  return { catId: value.catId, name: trimName(value.name) };
}

function confirmedState(state, cat) {
  return {
    ...state,
    step: 'C',
    selectedCatId: cat.catId,
    catNameDraft: cat.name,
    adoptionStatus: 'CONFIRMED',
    confirmedCat: { ...cat },
  };
}

/**
 * Events:
 * SELECT_CAT {catId}; SET_NAME {value}; NEXT; BACK; BEGIN_SUBMIT;
 * RESOLVE_SUBMIT {status: 'CONFIRMED'|'UNKNOWN'|'ERROR', confirmedCat?};
 * BEGIN_READ; RESOLVE_READ {status?: 'ERROR', confirmedCat?: {catId, name}|null}.
 *
 * Only A selects a cat; only B edits a name. ERROR means a definite failure.
 * An uncertain result must be UNKNOWN and can only resolve through a read.
 * A confirmed submission without an explicit record uses the locked draft.
 * Missing/invalid read results keep UNKNOWN unless ERROR explicitly confirms
 * failure. A valid confirmed record always takes priority over an ERROR flag.
 * Every call returns a new object, including ignored or invalid events.
 */
export function transition(state, event = {}) {
  const next = {
    ...state,
    confirmedCat: state.confirmedCat ? { ...state.confirmedCat } : null,
  };

  switch (event?.type) {
    case 'SELECT_CAT':
      if (isEditable(state) && state.step === 'A' && CAT_IDS.has(event.catId)) {
        next.selectedCatId = event.catId;
        next.adoptionStatus = 'UNCONFIRMED';
      }
      break;

    case 'SET_NAME':
      if (isEditable(state) && state.step === 'B' && typeof event.value === 'string') {
        // Preserve exactly what was typed while moving between unconfirmed pages.
        next.catNameDraft = event.value;
        next.adoptionStatus = 'UNCONFIRMED';
      }
      break;

    case 'NEXT':
      if (canContinue(state) && (state.step === 'A' || state.step === 'B')) {
        next.step = state.step === 'A' ? 'B' : 'C';
        next.adoptionStatus = 'UNCONFIRMED';
      }
      break;

    case 'BACK':
      if (isEditable(state) && (state.step === 'B' || state.step === 'C')) {
        next.step = state.step === 'C' ? 'B' : 'A';
        next.adoptionStatus = 'UNCONFIRMED';
      }
      break;

    case 'BEGIN_SUBMIT':
      if (state.step === 'C' && canContinue(state)) {
        next.adoptionStatus = 'SUBMITTING';
      }
      break;

    case 'RESOLVE_SUBMIT':
      if (state.adoptionStatus !== 'SUBMITTING') break;
      if (event.status === 'CONFIRMED') {
        const value = Object.hasOwn(event, 'confirmedCat')
          ? event.confirmedCat
          : { catId: state.selectedCatId, name: state.catNameDraft };
        const cat = readConfirmedCat(value);
        if (cat) return confirmedState(next, cat);
        next.adoptionStatus = 'UNKNOWN';
      } else if (event.status === 'UNKNOWN' || event.status === 'ERROR') {
        next.adoptionStatus = event.status;
      }
      break;

    case 'BEGIN_READ':
      // The UI may show read progress separately; UNKNOWN remains creation-locked.
      break;

    case 'RESOLVE_READ': {
      if (state.adoptionStatus !== 'UNKNOWN') break;
      const cat = readConfirmedCat(event.confirmedCat);
      if (cat) return confirmedState(next, cat);
      if (event.status === 'ERROR') next.adoptionStatus = 'ERROR';
      break;
    }
  }

  return next;
}

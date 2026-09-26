import assert from 'node:assert/strict';
import {
  initialState, countName, validateName, canContinue, transition,
} from '../flow-state.mjs';

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function namingState(name = '小咪', catId = 'cat-01') {
  let state = transition(initialState(), { type: 'SELECT_CAT', catId });
  state = transition(state, { type: 'NEXT' });
  return transition(state, { type: 'SET_NAME', value: name });
}

function confirmationState(name = '小咪', catId = 'cat-01') {
  return transition(namingState(name, catId), { type: 'NEXT' });
}

function submittingState(name = '小咪', catId = 'cat-01') {
  return transition(confirmationState(name, catId), { type: 'BEGIN_SUBMIT' });
}

function unknownState() {
  return transition(submittingState('  小云  ', 'cat-03'), {
    type: 'RESOLVE_SUBMIT', status: 'UNKNOWN',
  });
}

function assertIgnored(state, event) {
  const result = transition(state, event);
  assert.notStrictEqual(result, state, 'Even ignored events return a fresh object');
  assert.deepEqual(result, state);
}

test('initial visits are unselected, unconfirmed and independent', () => {
  const first = initialState();
  assert.deepEqual(first, {
    step: 'A', selectedCatId: null, catNameDraft: '',
    adoptionStatus: 'UNCONFIRMED', confirmedCat: null,
  });
  assert.notStrictEqual(first, initialState());
  assert.equal(canContinue(first), false);
  assertIgnored(first, { type: 'NEXT' });
  assertIgnored(first, { type: 'BEGIN_SUBMIT' });
});

test('selecting any valid cat stays on A; invalid IDs cannot enable continue', () => {
  for (const catId of ['cat-01', 'cat-02', 'cat-03', 'cat-04']) {
    const state = transition(initialState(), { type: 'SELECT_CAT', catId });
    assert.equal(state.step, 'A');
    assert.equal(state.adoptionStatus, 'UNCONFIRMED');
    assert.equal(state.selectedCatId, catId);
    assert.equal(canContinue(state), true);
  }
  for (const catId of ['01', 'cat-05', '', null, undefined]) {
    assertIgnored(initialState(), { type: 'SELECT_CAT', catId });
  }
});

test('blank names use the exact empty error, including surrounding Unicode spaces', () => {
  for (const name of ['', ' ', '\t\n', '\u3000\u00a0']) {
    assert.equal(countName(name), 0);
    assert.equal(validateName(name), '先给小猫起个名字吧。');
  }
  assert.equal(countName('  小 咪  '), 3, 'Internal spaces remain characters');
  assert.equal(validateName('  小咪  '), '');
});

test('12 Chinese graphemes are valid and 13 give the exact length error', () => {
  assert.equal(countName('喵'.repeat(12)), 12);
  assert.equal(validateName('喵'.repeat(12)), '');
  assert.equal(validateName('喵'.repeat(13)), '名字最多 12 个字哦。');
  assert.equal(countName(' \n' + '喵'.repeat(12) + '\t '), 12);
});

test('family emoji, flags, skin tones and combining marks each count as graphemes', () => {
  for (const glyph of ['👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'e\u0301', '❤️']) {
    assert.equal(countName(glyph), 1, glyph);
    assert.equal(validateName(glyph.repeat(12)), '', glyph);
    assert.equal(validateName(glyph.repeat(13)), '名字最多 12 个字哦。', glyph);
  }
  assert.equal(countName('小🐱👨‍👩‍👧‍👦🇨🇳'), 4);
});

test('the name draft survives backward navigation and selecting another cat', () => {
  let state = namingState('  团子🐱  ');
  state = transition(state, { type: 'BACK' });
  assert.equal(state.step, 'A');
  assert.equal(state.selectedCatId, 'cat-01');
  state = transition(state, { type: 'SELECT_CAT', catId: 'cat-04' });
  assert.equal(state.catNameDraft, '  团子🐱  ');
  state = transition(state, { type: 'NEXT' });
  assert.equal(state.step, 'B');
  assert.equal(state.selectedCatId, 'cat-04');
  assert.equal(state.catNameDraft, '  团子🐱  ');
  state = transition(state, { type: 'NEXT' });
  assert.equal(state.step, 'C');
  state = transition(state, { type: 'BACK' });
  assert.equal(state.step, 'B');
  assert.equal(state.catNameDraft, '  团子🐱  ');
});

test('C and submission require a valid cat and valid name', () => {
  for (const name of ['', ' ', '喵'.repeat(13)]) {
    const state = namingState(name);
    assert.equal(canContinue(state), false);
    assertIgnored(state, { type: 'NEXT' });
    assertIgnored({ ...state, step: 'C' }, { type: 'BEGIN_SUBMIT' });
  }
  const malformed = { ...namingState(), selectedCatId: 'cat-99' };
  assert.equal(canContinue(malformed), false);
  assertIgnored(malformed, { type: 'NEXT' });
  assertIgnored({ ...malformed, step: 'C' }, { type: 'BEGIN_SUBMIT' });
  assertIgnored(namingState(), { type: 'BEGIN_SUBMIT' });
  assertIgnored(confirmationState(), { type: 'NEXT' });
});

test('selection and naming are limited to their own unconfirmed pages', () => {
  assertIgnored(initialState(), { type: 'SET_NAME', value: '小云' });
  assertIgnored(namingState(), { type: 'SELECT_CAT', catId: 'cat-02' });
  assertIgnored(confirmationState(), { type: 'SET_NAME', value: '小云' });
  assertIgnored(namingState(), { type: 'SET_NAME', value: null });
});

test('submission starts once and keeps the cat and exact draft while locked', () => {
  const state = submittingState('  小咪  ');
  assert.equal(state.adoptionStatus, 'SUBMITTING');
  assert.equal(state.selectedCatId, 'cat-01');
  assert.equal(state.catNameDraft, '  小咪  ');
  assert.equal(canContinue(state), false);
  for (const event of [
    { type: 'BEGIN_SUBMIT' }, { type: 'BACK' }, { type: 'NEXT' },
    { type: 'SELECT_CAT', catId: 'cat-04' }, { type: 'SET_NAME', value: '新名字' },
  ]) assertIgnored(state, event);
});

test('definite submission failure preserves all values and permits a guarded retry', () => {
  const state = transition(submittingState('  团子  ', 'cat-02'), {
    type: 'RESOLVE_SUBMIT', status: 'ERROR',
  });
  assert.equal(state.step, 'C');
  assert.equal(state.adoptionStatus, 'ERROR');
  assert.equal(state.selectedCatId, 'cat-02');
  assert.equal(state.catNameDraft, '  团子  ');
  assert.equal(canContinue(state), true);
  const retried = transition(state, { type: 'BEGIN_SUBMIT' });
  assert.equal(retried.adoptionStatus, 'SUBMITTING');
  assertIgnored(retried, { type: 'BEGIN_SUBMIT' });
  const back = transition(state, { type: 'BACK' });
  assert.equal(back.step, 'B');
  assert.equal(back.adoptionStatus, 'UNCONFIRMED');
  assert.equal(back.catNameDraft, '  团子  ');
});

test('UNKNOWN allows rereading but never another creation or editing path', () => {
  const state = unknownState();
  assert.equal(state.catNameDraft, '  小云  ');
  assert.equal(canContinue(state), false);
  for (const event of [
    { type: 'BACK' }, { type: 'NEXT' }, { type: 'BEGIN_SUBMIT' },
    { type: 'SELECT_CAT', catId: 'cat-01' }, { type: 'SET_NAME', value: '别的名字' },
    { type: 'RESOLVE_SUBMIT', status: 'ERROR' },
    { type: 'RESOLVE_SUBMIT', status: 'CONFIRMED' },
    { type: 'BEGIN_READ' },
  ]) assertIgnored(state, event);
});

test('missing or invalid read results remain UNKNOWN; a stored record is authoritative', () => {
  const state = transition(unknownState(), { type: 'BEGIN_READ' });
  for (const confirmedCat of [
    null, undefined, {}, { catId: 'cat-05', name: '小云' },
    { catId: 'cat-01', name: '' }, { catId: 'cat-01', name: '喵'.repeat(13) },
  ]) assertIgnored(state, { type: 'RESOLVE_READ', confirmedCat });
  const recovered = transition(state, {
    type: 'RESOLVE_READ', confirmedCat: { catId: 'cat-04', name: '  已保存的名字  ' },
  });
  assert.equal(recovered.adoptionStatus, 'CONFIRMED');
  assert.equal(recovered.step, 'C');
  assert.equal(recovered.selectedCatId, 'cat-04');
  assert.equal(recovered.catNameDraft, '已保存的名字');
  assert.deepEqual(recovered.confirmedCat, { catId: 'cat-04', name: '已保存的名字' });
});

test('refresh recovery can retry after a read explicitly confirms the earlier save failed', () => {
  const pending = submittingState('  小云  ', 'cat-03');
  // The controller restores an interrupted SUBMITTING snapshot as UNKNOWN.
  const restored = { ...pending, adoptionStatus: 'UNKNOWN' };
  const reading = transition(restored, { type: 'BEGIN_READ' });
  for (const confirmedCat of [undefined, null, {}, { catId: 'cat-99', name: '小云' }]) {
    const failed = transition(reading, { type: 'RESOLVE_READ', status: 'ERROR', confirmedCat });
    assert.equal(failed.adoptionStatus, 'ERROR');
    assert.equal(failed.step, 'C');
    assert.equal(failed.selectedCatId, 'cat-03');
    assert.equal(failed.catNameDraft, '  小云  ');
    assert.equal(failed.confirmedCat, null);
    assert.equal(canContinue(failed), true);
    const retry = transition(failed, { type: 'BEGIN_SUBMIT' });
    assert.equal(retry.adoptionStatus, 'SUBMITTING');
    assertIgnored(retry, { type: 'BEGIN_SUBMIT' });
  }
  assert.equal(reading.adoptionStatus, 'UNKNOWN', 'Resolving a read does not mutate its input');
});

test('a valid read record wins over an ERROR flag and stays permanently confirmed', () => {
  const confirmed = transition(unknownState(), {
    type: 'RESOLVE_READ', status: 'ERROR',
    confirmedCat: { catId: 'cat-02', name: '  已存小猫  ' },
  });
  assert.equal(confirmed.adoptionStatus, 'CONFIRMED');
  assert.deepEqual(confirmed.confirmedCat, { catId: 'cat-02', name: '已存小猫' });
  assert.equal(confirmed.selectedCatId, 'cat-02');
  assert.equal(confirmed.catNameDraft, '已存小猫');
  assert.equal(canContinue(confirmed), false);
  assertIgnored(confirmed, { type: 'RESOLVE_READ', status: 'ERROR' });
  assertIgnored(confirmed, { type: 'BEGIN_SUBMIT' });
});

test('only UNKNOWN accepts a definite read failure; ambiguous results remain locked', () => {
  const errorEvent = { type: 'RESOLVE_READ', status: 'ERROR' };
  const failed = transition(submittingState(), { type: 'RESOLVE_SUBMIT', status: 'ERROR' });
  for (const state of [initialState(), confirmationState(), submittingState(), failed]) {
    assertIgnored(state, errorEvent);
  }
  for (const status of [undefined, null, '', 'error', 'CONFIRMED', 'UNKNOWN']) {
    assertIgnored(unknownState(), { type: 'RESOLVE_READ', status, confirmedCat: null });
  }
});

test('confirmed state has no rename, change-cat, back or second-create path', () => {
  const state = transition(submittingState('  小咪  '), {
    type: 'RESOLVE_SUBMIT', status: 'CONFIRMED',
  });
  assert.equal(state.adoptionStatus, 'CONFIRMED');
  assert.deepEqual(state.confirmedCat, { catId: 'cat-01', name: '小咪' });
  assert.equal(state.catNameDraft, '小咪');
  assert.equal(canContinue(state), false);
  for (const event of [
    { type: 'BACK' }, { type: 'NEXT' }, { type: 'BEGIN_SUBMIT' }, { type: 'BEGIN_READ' },
    { type: 'SELECT_CAT', catId: 'cat-04' }, { type: 'SET_NAME', value: '另一个' },
    { type: 'RESOLVE_SUBMIT', status: 'ERROR' },
    { type: 'RESOLVE_READ', confirmedCat: { catId: 'cat-04', name: '另一个' } },
  ]) assertIgnored(state, event);
});

test('explicit malformed confirmation is UNKNOWN rather than inventing saved success', () => {
  for (const confirmedCat of [null, {}, { catId: 'cat-99', name: '小云' }]) {
    const state = transition(submittingState(), {
      type: 'RESOLVE_SUBMIT', status: 'CONFIRMED', confirmedCat,
    });
    assert.equal(state.adoptionStatus, 'UNKNOWN');
    assert.equal(state.confirmedCat, null);
  }
  const stored = transition(submittingState(), {
    type: 'RESOLVE_SUBMIT', status: 'CONFIRMED',
    confirmedCat: { catId: 'cat-02', name: '云朵' },
  });
  assert.equal(stored.selectedCatId, 'cat-02');
  assert.equal(stored.catNameDraft, '云朵');
});

test('stale resolutions and unrecognized events cannot unlock or invent an adoption', () => {
  const initial = initialState();
  assertIgnored(initial, { type: 'RESOLVE_SUBMIT', status: 'CONFIRMED' });
  assertIgnored(initial, { type: 'RESOLVE_READ', confirmedCat: { catId: 'cat-01', name: '小咪' } });
  assertIgnored(initial, { type: 'UNRECOGNIZED' });
  assertIgnored(initial, null);
  assertIgnored(initial, undefined);
  assertIgnored(submittingState(), { type: 'RESOLVE_SUBMIT', status: 'UNCONFIRMED' });
});

test('transitions are pure and returned confirmed records do not alias their inputs', () => {
  const before = Object.freeze(submittingState());
  const record = Object.freeze({ catId: 'cat-03', name: '  奶团  ' });
  const event = Object.freeze({ type: 'RESOLVE_SUBMIT', status: 'CONFIRMED', confirmedCat: record });
  const after = transition(before, event);
  assert.equal(before.adoptionStatus, 'SUBMITTING');
  assert.equal(before.catNameDraft, '小咪');
  assert.equal(record.name, '  奶团  ');
  assert.notStrictEqual(after.confirmedCat, record);
  Object.freeze(after.confirmedCat);
  Object.freeze(after);
  const copy = transition(after, { type: 'BACK' });
  assert.notStrictEqual(copy.confirmedCat, after.confirmedCat);
  assert.deepEqual(copy, after);
});

test('REVIEW_CHOICE returns editable C directly to A and preserves the exact draft', () => {
  const draft = '  团子🐱  ';
  const ready = confirmationState(draft, 'cat-02');
  const failed = transition(submittingState(draft, 'cat-02'), {
    type: 'RESOLVE_SUBMIT', status: 'ERROR',
  });
  for (const before of [ready, failed]) {
    const reviewed = transition(Object.freeze(before), { type: 'REVIEW_CHOICE' });
    assert.equal(reviewed.step, 'A');
    assert.equal(reviewed.adoptionStatus, 'UNCONFIRMED');
    assert.equal(reviewed.selectedCatId, 'cat-02');
    assert.equal(reviewed.catNameDraft, draft);
    assert.equal(reviewed.confirmedCat, null);
    assert.equal(before.step, 'C');
    assert.equal(canContinue(reviewed), true);
    const changed = transition(reviewed, { type: 'SELECT_CAT', catId: 'cat-04' });
    const named = transition(changed, { type: 'NEXT' });
    assert.equal(named.step, 'B');
    assert.equal(named.selectedCatId, 'cat-04');
    assert.equal(named.catNameDraft, draft);
    assert.equal(transition(before, { type: 'BACK' }).step, 'B', 'Ordinary back still edits the name');
  }
});

test('REVIEW_CHOICE is ignored outside C and for every locked adoption state', () => {
  const confirmed = transition(submittingState(), { type: 'RESOLVE_SUBMIT', status: 'CONFIRMED' });
  for (const state of [
    initialState(), namingState(), submittingState(), unknownState(), confirmed,
    { ...namingState(), adoptionStatus: 'ERROR' },
  ]) assertIgnored(state, { type: 'REVIEW_CHOICE' });
});

console.log(`\n${passed} state-logic tests passed.`);

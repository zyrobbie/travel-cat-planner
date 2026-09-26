import assert from 'node:assert/strict';
import { initialState, transition as t, currentLetter, homePage, getHomeEntry, countReply,
  validateReply, canSubmit, LETTER_FIXTURES, validateSnapshot } from '../daily-state.mjs';
import { createDailyStore, STORAGE_KEY } from '../storage.mjs';

let passed = 0;
function test(name, run) { run(); console.log(`ok ${++passed} - ${name}`); }
function memoryStorage() {
  const data = new Map();
  return { data, writes: 0, reads: 0, failRead: false, failWrite: false,
    getItem(key) { this.reads++; if (this.failRead) throw Error('READ_DENIED'); return data.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw Error('QUOTA'); this.writes++; data.set(key, String(value)); },
    removeItem(key) { data.delete(key); } };
}
function editor(text = '明天也一起看看吧。') {
  return t(t(initialState(), { type: 'OPEN_NEED', letterId: 'need-01' }), { type: 'EDIT', value: text });
}
const saving = text => t(editor(text), { type: 'BEGIN_SAVE' });
const submitting = text => t(editor(text), { type: 'BEGIN_SUBMIT' });
const ticket = state => ({ ...state.pendingSubmission });
const dispatchResult = (state, result) => result.event ? t(state, result.event) : state;

test('initial home has exactly one unread need and no opened editor', () => {
  const state = initialState();
  assert.equal(state.catId, 'cat-01'); assert.equal(state.appearanceId, 'cat-01');
  assert.equal(state.catName, '小咪'); assert.equal(state.page, 'E');
  assert.equal(getHomeEntry(state).id, 'need-01'); assert.equal(state.currentLetterId, null);
  assert.equal(state.letters['need-01'].readState, 'UNREAD');
  assert.equal(validateSnapshot(state), true);
});

test('opening a need reads it and releases the slot without a reply', () => {
  const state = t(initialState(), { type: 'OPEN_NEED', letterId: 'need-01' });
  assert.equal(state.page, 'G'); assert.equal(state.newLetterId, null);
  assert.equal(currentLetter(state).readState, 'READ'); assert.equal(currentLetter(state).replySubmitState, 'IDLE');
  assert.equal(t(state, { type: 'SKIP' }).page, 'E');
});

test('arrivals obey one shared slot and cannot replace or duplicate letters', () => {
  const first = initialState();
  assert.deepEqual(t(first, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] }), first);
  let state = t(first, { type: 'OPEN_NEED', letterId: 'need-01' });
  state = t(state, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
  assert.equal(state.newLetterId, 'need-02'); assert.equal(Object.keys(state.letters).length, 2);
  assert.deepEqual(t(state, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] }), state);
  state = t(state, { type: 'OPEN_NEED', letterId: 'need-02' });
  assert.deepEqual(t(state, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-01'] }), state);
  assert.deepEqual(t(state, { type: 'NEW_LETTER', letter: { id: '__proto__', type: 'NEED_CARD' } }), state);
});

test('new mail does not replace the active editor or its draft; home prefers unread', () => {
  let state = editor('留在第一封里的文字');
  state = t(state, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
  assert.equal(state.page, 'G'); assert.equal(state.currentLetterId, 'need-01');
  assert.equal(currentLetter(state).draft, '留在第一封里的文字');
  state = t(state, { type: 'BACK_HOME' });
  assert.equal(state.page, 'E'); assert.equal(getHomeEntry(state).id, 'need-02');
  state = t(state, { type: 'OPEN_NEED', letterId: 'need-02' });
  state = t(state, { type: 'EDIT', value: '第二封的草稿' });
  assert.equal(state.letters['need-01'].draft, '留在第一封里的文字');
  state = t(state, { type: 'SKIP' });
  assert.equal(state.letters['need-02'].draft, '第二封的草稿');
});

test('2000 graphemes are valid; 2001 remain intact and cannot be submitted', () => {
  assert.equal(countReply('🐈‍⬛'), 1); assert.equal(countReply('e\u0301'), 1);
  assert.equal(validateReply('🐈‍⬛'.repeat(2000)), '');
  assert.equal(canSubmit(editor('喵'.repeat(2000))), true);
  const over = editor('喵'.repeat(2001));
  assert.equal(currentLetter(over).draft.length, 2001); assert.equal(canSubmit(over), false);
  assert.ok(validateReply(currentLetter(over).draft));
  assert.equal(canSubmit(editor(' \n\u3000')), false);
  assert.equal(countReply(' a '), 3);
});

test('stale save completions cannot mark a newer draft saved or failed', () => {
  const old = saving('旧草稿');
  let state = t(old, { type: 'EDIT', value: '新草稿' });
  state = t(state, { type: 'BEGIN_SAVE' });
  for (const type of ['SAVE_SUCCESS', 'SAVE_ERROR']) {
    assert.deepEqual(t(state, { type, ...old.pendingSave }), state);
  }
  const saved = t(state, { type: 'SAVE_SUCCESS', ...state.pendingSave });
  assert.equal(saved.draftSaveState, 'SAVED'); assert.equal(currentLetter(saved).draft, '新草稿');
});

test('submission locks duplicate sends and keeps the exact input', () => {
  const state = submitting('  一句话🐈‍⬛  ');
  assert.equal(state.replySubmitState, 'SUBMITTING'); assert.equal(canSubmit(state), false);
  assert.equal(currentLetter(state).draft, '  一句话🐈‍⬛  ');
  for (const event of [{ type: 'BEGIN_SUBMIT' }, { type: 'EDIT', value: '覆盖' },
    { type: 'BACK_HOME' }, { type: 'SKIP' }, { type: 'OPEN_NEED', letterId: 'need-01' }]) assert.deepEqual(t(state, event), state);
});

test('send error preserves input; stale errors cannot undo a later attempt or success', () => {
  const first = submitting('不要丢掉这句话');
  const failed = t(first, { type: 'SEND_ERROR', ...ticket(first) });
  assert.equal(failed.replySubmitState, 'ERROR'); assert.equal(currentLetter(failed).draft, '不要丢掉这句话');
  const second = t(failed, { type: 'BEGIN_SUBMIT' });
  assert.notEqual(second.pendingSubmission.requestId, first.pendingSubmission.requestId);
  assert.deepEqual(t(second, { type: 'SEND_ERROR', ...ticket(first) }), second);
  const sent = t(second, { type: 'SEND_SUCCESS', ...ticket(second) });
  assert.equal(sent.page, 'H'); assert.equal(sent.replySubmitState, 'SUCCESS');
  assert.deepEqual(t(sent, { type: 'SEND_ERROR', ...ticket(second) }), sent);
  assert.equal(canSubmit(sent), false);
});

test('system check and safety states are separate and never show success', () => {
  for (const [type, expected] of [['CHECK_ERROR', 'CHECK_ERROR'], ['SAFETY_BLOCKED', 'SAFETY']]) {
    const pending = submitting('原文');
    const state = t(pending, { type, ...ticket(pending) });
    assert.equal(state.page, 'G'); assert.equal(state.replySubmitState, 'IDLE');
    assert.equal(state.checkState, expected); assert.equal(currentLetter(state).draft, '原文');
    assert.equal(currentLetter(state).receiptId, null);
    assert.equal(t(state, { type: 'EDIT', value: '修改后的原文' }).checkState, 'IDLE');
  }
});

test('trip and postcard read are independent, including returning with an unread postcard', () => {
  let state = t(initialState(), { type: 'OPEN_NEED', letterId: 'need-01' });
  state = t(state, { type: 'BACK_HOME' }); state = t(state, { type: 'CAT_TRIP' });
  state = t(state, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] });
  assert.equal(state.page, 'F');
  const returned = t(state, { type: 'CAT_HOME' });
  assert.equal(returned.page, 'E'); assert.equal(returned.newLetterId, 'postcard-01');
  state = t(state, { type: 'POSTCARD_READ', letterId: 'postcard-01' });
  assert.equal(state.catState, 'TRIP'); assert.equal(state.page, 'F'); assert.equal(state.newLetterId, null);
  assert.equal(state.letters['postcard-01'].readState, 'READ');
});

test('successful reply does not start or end a trip and creates no immediate cat reply', () => {
  for (const catState of ['HOME', 'TRIP']) {
    let state = submitting(); if (catState === 'TRIP') state = t(state, { type: 'CAT_TRIP' });
    const sent = t(state, { type: 'SEND_SUCCESS', ...ticket(state) });
    assert.equal(sent.catState, catState); assert.equal(sent.page, 'H');
    assert.equal(sent.newLetterId, null); assert.equal(Object.keys(sent.letters).length, 1);
    assert.equal(t(sent, { type: 'BACK_HOME' }).page, catState === 'HOME' ? 'E' : 'F');
  }
});

test('model operations do not mutate their input or caller letter data', () => {
  const before = editor(); const copy = structuredClone(before);
  const letter = { ...LETTER_FIXTURES['need-02'], data: { source: 'demo' } };
  const after = t(before, { type: 'NEW_LETTER', letter });
  after.letters['need-02'].data.source = 'changed';
  assert.deepEqual(before, copy); assert.equal(letter.data.source, 'demo');
});

test('a real storage object receives a versioned independent-key snapshot', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const empty = store.load(); assert.equal(empty.fresh, true); assert.equal(storage.writes, 0);
  const saved = store.persist(editor('持久化的草稿'));
  assert.equal(saved.ok, true); assert.equal(storage.writes, 1);
  assert.equal(storage.data.has(STORAGE_KEY), true);
  assert.equal(JSON.parse(storage.data.get(STORAGE_KEY)).version, 1);
  assert.equal(currentLetter(store.load().state).draft, '持久化的草稿');
});

test('draft SAVED is returned only after actual setItem success', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const state = saving('保存原文');
  storage.failWrite = true;
  const error = store.saveDraft(state);
  assert.equal(error.ok, false); assert.equal(error.event.type, 'SAVE_ERROR'); assert.equal(storage.writes, 0);
  let live = dispatchResult(state, error);
  assert.equal(live.draftSaveState, 'ERROR'); assert.equal(currentLetter(live).draft, '保存原文');
  storage.failWrite = false; live = t(live, { type: 'BEGIN_SAVE' });
  const result = store.saveDraft(live); assert.equal(result.ok, true); assert.equal(storage.writes, 1);
  live = dispatchResult(live, result); assert.equal(live.draftSaveState, 'SAVED');
  const restored = store.load().state;
  assert.equal(currentLetter(restored).draft, '保存原文'); assert.equal(restored.draftSaveState, 'SAVED');
});

test('old save callback cannot overwrite newer persisted text', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const old = saving('旧原文');
  const newer = t(old, { type: 'EDIT', value: '新原文' });
  assert.equal(store.persist(newer).ok, true);
  const result = store.saveDraft(old);
  assert.equal(result.stale, true); assert.equal(result.event, undefined);
  assert.equal(currentLetter(store.load().state).draft, '新原文');
});

test('save acknowledgements preserve a newer unrelated letter arrival', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const old = saving('第一封');
  const arrived = t(old, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
  assert.equal(store.persist(arrived).ok, true);
  const result = store.saveDraft(old); assert.equal(result.ok, true);
  const loaded = store.load().state;
  assert.equal(loaded.newLetterId, 'need-02'); assert.equal(loaded.letters['need-01'].draft, '第一封');
});

test('cold restore shows unread home while preserving the old draft and read history', () => {
  const store = createDailyStore({ storage: memoryStorage() });
  const state = t(editor('旧草稿'), { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
  assert.equal(store.persist(state).ok, true);
  const loaded = store.load().state;
  assert.equal(loaded.page, 'E'); assert.equal(getHomeEntry(loaded).id, 'need-02');
  assert.equal(loaded.letters['need-01'].draft, '旧草稿'); assert.equal(loaded.letters['need-01'].readState, 'READ');
  assert.equal(loaded.letters['need-02'].readState, 'UNREAD');
});

test('one atomic commit stores reply plus receipt; duplicate callback performs no second write', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const pending = submitting('只发送一次');
  const first = store.commitReply(pending); assert.equal(first.ok, true); assert.equal(storage.writes, 1);
  const second = store.commitReply(pending); assert.equal(second.ok, true); assert.equal(second.reused, true);
  assert.equal(storage.writes, 1);
  const envelope = JSON.parse(storage.data.get(STORAGE_KEY));
  assert.equal(Object.keys(envelope.receipts).length, 1);
  assert.equal(envelope.state.letters['need-01'].submittedText, '只发送一次');
  assert.equal(store.load().state.page, 'H'); assert.equal(store.load().state.replySubmitState, 'SUCCESS');
});

test('success persists before delayed UI acknowledgement; refresh cannot resend', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const pending = submitting(); store.persist(pending);
  const sent = store.commitReply(pending); assert.equal(sent.ok, true);
  const restored = store.load().state;
  assert.equal(restored.page, 'H'); assert.equal(canSubmit(restored), false);
  assert.equal(store.persist(pending).stale, true);
  assert.equal(store.load().state.replySubmitState, 'SUCCESS');
});

test('refresh during uncommitted submission requires read; read without receipt permits retry without sending', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  store.persist(submitting('尚未提交到本机的文字'));
  let restored = store.load().state;
  assert.equal(restored.submissionRecoveryRequired, true); assert.equal(canSubmit(restored), false);
  assert.deepEqual(t(restored, { type: 'BEGIN_SUBMIT' }), restored);
  const writes = storage.writes;
  const result = store.recoverSubmission(restored);
  assert.equal(result.event.type, 'SEND_ERROR'); assert.equal(storage.writes, writes);
  restored = dispatchResult(restored, result);
  assert.equal(restored.replySubmitState, 'ERROR'); assert.equal(canSubmit(restored), true);
  assert.equal(currentLetter(restored).draft, '尚未提交到本机的文字');
});

test('ambiguous read failures retain the submission lock and can recover a committed receipt', () => {
  const storage = memoryStorage(); const fixtures = { readError: 0 };
  const store = createDailyStore({ storage, failFixtures: fixtures });
  const pending = submitting(); store.commitReply(pending);
  fixtures.readError = 1;
  let live = dispatchResult(pending, store.commitReply(pending));
  assert.equal(live.submissionRecoveryRequired, true); assert.equal(canSubmit(live), false);
  live = dispatchResult(live, store.recoverSubmission(live));
  assert.equal(live.replySubmitState, 'SUCCESS'); assert.equal(live.page, 'H'); assert.equal(storage.writes, 1);
});

test('rejected setItem never fabricates success or a receipt; retry preserves original text', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  let state = submitting('失败后要保留'); storage.failWrite = true;
  const result = store.commitReply(state); assert.equal(result.ok, false); assert.equal(result.event.type, 'SEND_ERROR');
  assert.equal(storage.data.size, 0); state = dispatchResult(state, result);
  assert.equal(currentLetter(state).draft, '失败后要保留'); assert.equal(state.page, 'G');
  storage.failWrite = false; state = t(state, { type: 'BEGIN_SUBMIT' });
  state = dispatchResult(state, store.commitReply(state));
  assert.equal(state.page, 'H'); assert.equal(currentLetter(state).submittedText, '失败后要保留');
});

test('check, safety and send fixtures keep distinct system states and no success receipt', () => {
  for (const [fixture, status, check] of [['checkError', 'IDLE', 'CHECK_ERROR'],
    ['safetyBlocked', 'IDLE', 'SAFETY'], ['sendError', 'ERROR', 'IDLE']]) {
    const storage = memoryStorage(); const fixtures = { [fixture]: 1 };
    const store = createDailyStore({ storage, failFixtures: fixtures });
    const pending = submitting('原文保留'); const result = store.commitReply(pending);
    const live = dispatchResult(pending, result);
    assert.equal(live.page, 'G'); assert.equal(live.replySubmitState, status); assert.equal(live.checkState, check);
    assert.equal(currentLetter(live).draft, '原文保留');
    assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)).receipts, {}); assert.equal(fixtures[fixture], 0);
  }
});

test('read failure after success keeps H and cannot turn into another send', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const pending = submitting(); const sent = dispatchResult(pending, store.commitReply(pending));
  storage.failRead = true;
  const result = store.load(sent);
  assert.equal(result.ok, false); assert.equal(result.state.page, 'H'); assert.equal(result.state.refreshError, true);
  assert.equal(result.state.replySubmitState, 'SUCCESS'); assert.equal(canSubmit(result.state), false);
  assert.equal(currentLetter(result.state).submittedText, currentLetter(sent).submittedText);
});

test('corrupt or unavailable storage is reported without clearing or replacing it', () => {
  const storage = memoryStorage(); storage.data.set(STORAGE_KEY, '{broken');
  const store = createDailyStore({ storage });
  const result = store.load(); assert.equal(result.ok, false); assert.equal(result.state.loadError, true);
  assert.equal(storage.data.get(STORAGE_KEY), '{broken'); assert.equal(storage.writes, 0);
  assert.equal(store.persist(initialState()).ok, false); assert.equal(storage.writes, 0);
  storage.failRead = true; assert.equal(store.load().ok, false);
});

test('state-only persist never claims SAVED and keeps data isolated from other preview keys', () => {
  const storage = memoryStorage(); storage.data.set('formal-app-key', 'unchanged');
  const store = createDailyStore({ storage, key: 'independent-test-key' });
  const state = editor('临时输入'); store.persist(state);
  assert.equal(store.load().state.draftSaveState, 'IDLE');
  assert.equal(storage.data.get('formal-app-key'), 'unchanged'); assert.equal(storage.data.has(STORAGE_KEY), false);
});

test('trip changes and fresh mail during send survive durable reply commit', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const pending = submitting(); store.persist(pending);
  let latest = t(pending, { type: 'CAT_TRIP' });
  latest = t(latest, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] });
  store.persist(latest);
  const result = store.commitReply(pending);
  latest = dispatchResult(latest, result);
  assert.equal(latest.catState, 'TRIP'); assert.equal(latest.newLetterId, 'postcard-01'); assert.equal(latest.page, 'H');
  const restored = store.load().state;
  assert.equal(restored.catState, 'TRIP'); assert.equal(restored.newLetterId, 'postcard-01');
  assert.equal(homePage(restored), 'F'); assert.equal(Object.keys(restored.letters).length, 2);
});

test('storage failure cannot relabel a system check or safety outcome as a send error', () => {
  for (const [outcome, check] of [['CHECK_ERROR', 'CHECK_ERROR'], ['SAFETY', 'SAFETY']]) {
    const storage = memoryStorage(); storage.failWrite = true;
    const store = createDailyStore({ storage }); const pending = submitting('保留文字');
    const result = store.commitReply(pending, { outcome });
    const live = dispatchResult(pending, result);
    assert.equal(result.ok, false); assert.equal(live.checkState, check);
    assert.equal(live.replySubmitState, 'IDLE'); assert.equal(live.page, 'G');
    assert.equal(currentLetter(live).draft, '保留文字'); assert.equal(storage.writes, 0);
  }
});

test('durable receipt protects against a later stale snapshot attempting to rewrite sent text', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const pending = submitting('已经发出的原文'); store.commitReply(pending);
  const altered = store.load().state;
  altered.letters['need-01'].submittedText = '不应覆盖'; altered.letters['need-01'].draft = '也不应重新出现';
  altered.revision += 1;
  const result = store.persist(altered);
  assert.equal(result.ok, true);
  const loaded = store.load(); assert.equal(loaded.ok, true);
  assert.equal(currentLetter(loaded.state).submittedText, '已经发出的原文');
  assert.equal(currentLetter(loaded.state).draft, ''); assert.equal(canSubmit(loaded.state), false);
});

test('two tabs with equal revision and different text cannot silently overwrite each other', () => {
  const storage = memoryStorage(); const a = createDailyStore({ storage }); const b = createDailyStore({ storage });
  a.persist(editor('共同起点'));
  const aState = t(a.load().state, { type: 'EDIT', value: 'A 标签写下的文字' });
  const bState = t(b.load().state, { type: 'EDIT', value: 'B 标签仍在内存中的文字' });
  assert.equal(aState.revision, bState.revision);
  assert.equal(a.persist(aState).ok, true);
  const conflict = b.persist(bState);
  assert.equal(conflict.ok, false); assert.equal(conflict.conflict, true); assert.equal(conflict.stale, true);
  assert.equal(currentLetter(a.load().state).draft, 'A 标签写下的文字');
  assert.equal(currentLetter(bState).draft, 'B 标签仍在内存中的文字');
  assert.equal(a.persist(a.load().state).ok, true, 'An unchanged snapshot is safe to persist');
});

test('a same-revision save acknowledgement cannot revert another tab trip or letter arrival', () => {
  for (const event of [{ type: 'CAT_TRIP' }, { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] }]) {
    const storage = memoryStorage(); const a = createDailyStore({ storage }); const b = createDailyStore({ storage });
    const shared = editor('同一份草稿'); a.persist(shared);
    const savingState = t(shared, { type: 'BEGIN_SAVE' });
    const changed = t(shared, event); assert.equal(savingState.revision, changed.revision);
    assert.equal(a.persist(changed).ok, true);
    assert.equal(b.saveDraft(savingState).ok, true);
    const restored = a.load().state;
    assert.equal(restored.catState, changed.catState); assert.equal(restored.newLetterId, changed.newLetterId);
    assert.equal(restored.letters['need-01'].draft, '同一份草稿');
  }
});

test('legitimate restore normalization advances revision before the next persist', () => {
  const store = createDailyStore({ storage: memoryStorage() });
  const state = t(editor(), { type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
  store.persist(state); const loaded = store.load().state;
  assert.equal(loaded.page, 'E'); assert.equal(loaded.revision, state.revision + 1);
  assert.equal(store.persist(loaded).ok, true);
});

test('reply commit merges into latest equal-revision state without undoing independent trip changes', () => {
  const storage = memoryStorage(); const a = createDailyStore({ storage }); const b = createDailyStore({ storage });
  const shared = editor('回应正文'); a.persist(shared);
  const pending = t(shared, { type: 'BEGIN_SUBMIT' });
  const trip = t(shared, { type: 'CAT_TRIP' }); assert.equal(pending.revision, trip.revision);
  a.persist(trip); assert.equal(b.commitReply(pending).ok, true);
  const loaded = a.load().state;
  assert.equal(loaded.page, 'H'); assert.equal(loaded.catState, 'TRIP');
  assert.equal(currentLetter(loaded).submittedText, '回应正文');
});

test('missing key preserves the current draft or successful reply instead of creating a fresh cat', () => {
  const storage = memoryStorage(); const store = createDailyStore({ storage });
  const draft = editor('记录消失时仍保留的文字');
  const missingDraft = store.load(draft);
  assert.equal(missingDraft.ok, false); assert.equal(missingDraft.error, 'MISSING_SNAPSHOT');
  assert.equal(missingDraft.state.page, 'G'); assert.equal(missingDraft.state.loadError, true);
  assert.equal(currentLetter(missingDraft.state).draft, '记录消失时仍保留的文字');
  assert.equal(missingDraft.state.newLetterId, null); assert.equal(storage.writes, 0);
  const pending = submitting('已经送出的文字');
  const sent = dispatchResult(pending, store.commitReply(pending));
  storage.removeItem(STORAGE_KEY);
  const missingSent = store.load(sent);
  assert.equal(missingSent.ok, false); assert.equal(missingSent.state.page, 'H');
  assert.equal(missingSent.state.refreshError, true); assert.equal(missingSent.state.replySubmitState, 'SUCCESS');
  assert.equal(currentLetter(missingSent.state).submittedText, '已经送出的文字');
  assert.equal(canSubmit(missingSent.state), false); assert.equal(missingSent.state.newLetterId, null);
  const firstVisit = store.load();
  assert.equal(firstVisit.ok, true); assert.equal(firstVisit.fresh, true);
  assert.equal(firstVisit.state.newLetterId, 'need-01');
});

test('check error permits explicit retry; safety blocks retry until a genuine edit', () => {
  const pending = submitting('检查前的原文');
  const checkError = t(pending, { type: 'CHECK_ERROR', ...ticket(pending) });
  assert.equal(canSubmit(checkError), true);
  assert.equal(t(checkError, { type: 'BEGIN_SUBMIT' }).replySubmitState, 'SUBMITTING');
  const safety = t(pending, { type: 'SAFETY_BLOCKED', ...ticket(pending) });
  assert.equal(canSubmit(safety), false);
  assert.deepEqual(t(safety, { type: 'BEGIN_SUBMIT' }), safety);
  assert.equal(canSubmit(t(safety, { type: 'EDIT', value: currentLetter(safety).draft })), false);
  assert.equal(canSubmit(t(safety, { type: 'EDIT', value: '修改后的文字' })), true);
});

console.log(`\n${passed} daily model/storage tests passed.`);

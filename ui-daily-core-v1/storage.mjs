import { initialState, transition, currentLetter, restoreSnapshot, validateSnapshot } from './daily-state.mjs?v=batch3-20261003-3';
import {upgradeHistory,currentRevision,applyMutation,redactResponse} from './response-history.mjs?v=batch3-20261003-3';

export const STORAGE_KEY = 'cat-letters-ui-daily-core-v1:preview-v1';
export const LIVE_STORAGE_KEY='cat-letters-e3-g2r:daily-v1';
export const LEGACY_IMPORT_MARKER_KEY=`${LIVE_STORAGE_KEY}:legacy-import`;
const clone = value => structuredClone(value);
const failed = (error, extra = {}) => ({ ok: false, error, ...extra });

/**
 * Browser localStorage or an injected Storage-compatible object. All methods
 * are synchronous: let the controller display progress, then dispatch the
 * returned event to its latest state. No timers, networking or real moderation.
 * Fail fixtures: readError/writeError/draftError/sendError/checkError/safetyBlocked.
 * true = persistent failure; a positive integer = fail that many times.
 */
export function createDailyStore({ storage, key = STORAGE_KEY, failFixtures = {}, initialOptions = {} } = {}) {
  let adapter = storage;
  if (!adapter) {
    try { adapter = globalThis.localStorage; } catch { adapter = null; }
  }
  function shouldFail(name) {
    const value = failFixtures[name];
    if (typeof value === 'function') return !!value();
    if (typeof value === 'number' && value > 0) { failFixtures[name] -= 1; return true; }
    return value === true;
  }
  function readEnvelope() {
    if (shouldFail('readError') || !adapter) throw new Error('READ_ERROR');
    const raw = adapter.getItem(key);
    if (raw === null) return null;
    const envelope = JSON.parse(raw);
    if (![1,2].includes(envelope?.version) || !validateSnapshot(envelope.state) || !envelope.receipts
      || typeof envelope.receipts !== 'object' || Array.isArray(envelope.receipts)) throw new Error('INVALID_SNAPSHOT');
    if(envelope.version!==envelope.state.schemaVersion)throw new Error('INVALID_SCHEMA');
    const legacy=envelope.version===1;
    for (const [id, receipt] of Object.entries(envelope.receipts)) {
      if (!receipt || receipt.requestId !== id || receipt.status !== 'SUCCESS'
        || typeof receipt.letterId !== 'string'||
        !(typeof receipt.text==='string'||!legacy&&receipt.text===null&&receipt.redacted===true))throw new Error('INVALID_RECEIPT');
      const letter = envelope.state.letters[receipt.letterId];
      if (!letter || letter.replySubmitState !== 'SUCCESS' || letter.receiptId !== id)throw new Error('INCONSISTENT_RECEIPT');
      if(legacy){if(letter.submittedText!==receipt.text)throw new Error('INCONSISTENT_RECEIPT');}
      else{
        const response=envelope.state.responses[letter.responseId];
        if(!response||response.status==='DELETED'&&!(receipt.redacted&&receipt.text===null&&letter.submittedText===null)||
          response.status==='ACTIVE'&&receipt.text!==response.revisions[0]?.text)throw new Error('INCONSISTENT_RECEIPT');
      }
    }
    if(legacy){envelope.state=upgradeHistory(envelope.state);envelope.version=2;envelope.migrated=true;}
    return envelope;
  }
  function writeEnvelope(state, receipts) {
    if (!validateSnapshot(state)) throw new Error('INVALID_SNAPSHOT');
    if (shouldFail('writeError') || !adapter) throw new Error('WRITE_ERROR');
    // One key / one setItem is the atomic unit: a reply and its receipt cannot
    // be split across two writes or reported successful before storage accepts it.
    adapter.setItem(key, JSON.stringify({ version: 2, state, receipts }));
  }
  function resultEvent(state, type, extra = {}) {
    const pending = currentLetter(state)?.pendingSubmission;
    return pending ? { type, letterId: pending.letterId, requestId: pending.requestId, ...extra } : null;
  }
  function successEvent(state, receipt) {
    return resultEvent(state, 'SEND_SUCCESS', { receiptId: receipt.requestId, text: receipt.text });
  }
  function protectReceipts(state, receipts) {
    const next = clone(state);
    let changed = false;
    for (const receipt of Object.values(receipts)) {
      const letter = next.letters[receipt.letterId];
      if (!letter) throw new Error('STALE_STATE');
      const response=next.responses[letter.responseId];
      if(response?.status==='DELETED'){
        if(!receipt.redacted||receipt.text!==null||letter.submittedText!==null)throw new Error('REDACTION_CONFLICT');
        continue;
      }
      if(response?.status==='ACTIVE'){
        if(receipt.text!==response.revisions[0]?.text)throw new Error('RECEIPT_CONFLICT');
        const latest=currentRevision(response)?.text;
        if(letter.submittedText===latest&&letter.draft==='')continue;
        letter.submittedText=latest;
      }else if (letter.replySubmitState === 'SUCCESS' && letter.receiptId === receipt.requestId
        && letter.submittedText === receipt.text && letter.draft === '') continue;
      else letter.submittedText=receipt.text;
      letter.replySubmitState = 'SUCCESS'; letter.checkState = 'IDLE';
      letter.receiptId = receipt.requestId;
      letter.draft = ''; letter.draftRevision = Math.max(letter.draftRevision, receipt.revision + 1);
      letter.savedRevision = letter.draftRevision; letter.draftSaveState = 'IDLE';
      letter.pendingSave = null; letter.pendingSubmission = null;
      if (next.currentLetterId === letter.id) {
        next.submissionRecoveryRequired = false;
        if (next.page === 'G') next.page = 'H';
      }
      changed = true;
    }
    if (changed) next.revision += 1;
    // A no-op model transition also refreshes the public current-letter mirrors.
    return transition(next, { type: 'SYNC' });
  }
  function load(fallbackState) {
    try {
      const envelope = readEnvelope();
      // Missing data is only a fresh visit when no current experience exists.
      // In particular, never replace an already-sent screen with a new letter.
      if (!envelope && fallbackState) throw new Error('MISSING_SNAPSHOT');
      const state = envelope ? restoreSnapshot(envelope.state) : initialState(initialOptions);
      // Restoration may legitimately change page or transient save/submit flags.
      // Give that change its own revision so same-revision conflict checks do
      // not confuse it with a second tab silently overwriting a stored snapshot.
      if (envelope && JSON.stringify(state) !== JSON.stringify(envelope.state)) state.revision += 1;
      return { ok: true, state,
        fresh: !envelope, recovered: !!envelope };
    } catch (error) {
      const fallback = fallbackState ? clone(fallbackState) : initialState(initialOptions);
      const sent = currentLetter(fallback)?.replySubmitState === 'SUCCESS';
      return failed(error.message || 'READ_ERROR', {
        state: transition(fallback, { type: sent ? 'REFRESH_ERROR' : 'LOAD_ERROR' })
      });
    }
  }
  function persist(state) {
    try {
      const envelope = readEnvelope();
      const receipts = envelope?.receipts || {};
      // Navigation and draft saves may never roll back a response mutation,
      // even if their unrelated state revisions have advanced in another tab.
      if(envelope&&(JSON.stringify(envelope.state.responses)!==JSON.stringify(state.responses)||
        JSON.stringify(envelope.state.mutationLog)!==JSON.stringify(state.mutationLog)))
        return failed('STALE_RESPONSE_HISTORY',{stale:true});
      for(const [id,previous] of Object.entries(envelope?.state.responses||{})){
        if(previous.status==='DELETED'&&state.responses?.[id]?.status!=='DELETED')
          return failed('REDACTION_CONFLICT',{stale:true});
      }
      // A delayed save must not overwrite a newer navigation, arrival or draft.
      if (envelope && envelope.state.revision > state.revision) return failed('STALE_STATE', { stale: true });
      if (envelope && envelope.state.revision === state.revision
        && JSON.stringify(envelope.state) !== JSON.stringify(state)) {
        return failed('CONFLICT_STATE', { stale: true, conflict: true });
      }
      const protectedState = protectReceipts(state, receipts);
      writeEnvelope(protectedState, receipts);
      return { ok: true, state: protectedState };
    } catch (error) { return failed(error.message || 'WRITE_ERROR'); }
  }
  function saveDraft(savingState) {
    const pending = currentLetter(savingState)?.pendingSave;
    if (!pending) return failed('NO_PENDING_SAVE');
    const eventBase = { letterId: pending.letterId, revision: pending.revision, requestId: pending.requestId };
    try {
      if (shouldFail('draftError')) throw new Error('DRAFT_SAVE_ERROR');
      const envelope = readEnvelope();
      const receipts = envelope?.receipts || {};
      const savedLetter = envelope?.state.letters[pending.letterId];
      const inputLetter = savingState.letters[pending.letterId];
      if (savedLetter && (savedLetter.draftRevision > pending.revision || savedLetter.replySubmitState === 'SUCCESS'
        || (savedLetter.draftRevision === pending.revision && savedLetter.draft !== inputLetter.draft))) {
        return failed('STALE_SAVE', { stale: true });
      }
      // Keep newer events for other letters; update only the matching draft.
      const base = clone(envelope ? envelope.state : savingState);
      const letter = base.letters[pending.letterId];
      if (!letter) throw new Error('MISSING_LETTER');
      base.revision = Math.max(base.revision, savingState.revision);
      base.operationSeq = Math.max(base.operationSeq, savingState.operationSeq);
      Object.assign(letter, { draft: inputLetter.draft, draftRevision: inputLetter.draftRevision,
        draftSaveState: 'SAVING', pendingSave: clone(pending) });
      if (inputLetter.readState === 'READ') {
        letter.readState = 'READ';
        if (base.newLetterId === pending.letterId) base.newLetterId = null;
      }
      const event = { type: 'SAVE_SUCCESS', ...eventBase };
      const saved = protectReceipts(transition(base, event), receipts);
      writeEnvelope(saved, receipts);
      return { ok: true, event };
    } catch (error) {
      return failed(error.message || 'DRAFT_SAVE_ERROR', { event: { type: 'SAVE_ERROR', ...eventBase } });
    }
  }
  function commitReply(submittingState, { outcome = 'SUCCESS' } = {}) {
    const pending = currentLetter(submittingState)?.pendingSubmission;
    if (!pending || currentLetter(submittingState).replySubmitState !== 'SUBMITTING') return failed('NO_PENDING_SUBMISSION');
    let envelope;
    try { envelope = readEnvelope(); }
    catch (error) {
      // A read failure is ambiguous: an earlier attempt may already have a receipt.
      return failed(error.message || 'READ_ERROR', { event: resultEvent(submittingState, 'SUBMIT_UNKNOWN') });
    }
    const receipts = clone(envelope?.receipts || {});
    const existing = receipts[pending.requestId] || Object.values(receipts).find(receipt => receipt.letterId === pending.letterId);
    if(existing?.redacted)return failed('REDACTED_REPLY',{stale:true});
    if (existing) return { ok: true, reused: true, event: successEvent(submittingState, existing) };
    const savedLetter = envelope?.state.letters[pending.letterId];
    if (savedLetter && savedLetter.draftRevision > pending.revision) {
      return failed('STALE_SUBMISSION', { event: resultEvent(submittingState, 'CHECK_ERROR') });
    }
    if (shouldFail('checkError')) outcome = 'CHECK_ERROR';
    else if (shouldFail('safetyBlocked')) outcome = 'SAFETY';
    else if (shouldFail('sendError')) outcome = 'ERROR';
    const eventType = { SUCCESS: 'SEND_SUCCESS', ERROR: 'SEND_ERROR', CHECK_ERROR: 'CHECK_ERROR',
      SAFETY: 'SAFETY_BLOCKED', SAFETY_BLOCKED: 'SAFETY_BLOCKED' }[outcome];
    if (!eventType) return failed('INVALID_OUTCOME', { event: resultEvent(submittingState, 'CHECK_ERROR') });
    const base = clone(envelope ? envelope.state : submittingState);
    const target = base.letters[pending.letterId];
    if (!target || target.draftRevision > pending.revision
      || (target.draftRevision === pending.revision && target.draft !== pending.text)) {
      return failed('STALE_SUBMISSION', { event: resultEvent(submittingState, 'CHECK_ERROR') });
    }
    // If the controller has not separately saved BEGIN_SUBMIT, add only its lock.
    target.draft = pending.text; target.draftRevision = pending.revision;
    target.readState = 'READ';
    if (base.newLetterId === pending.letterId) base.newLetterId = null;
    target.pendingSubmission = clone(pending); target.replySubmitState = 'SUBMITTING';
    base.currentLetterId = pending.letterId;
    base.revision = Math.max(base.revision, submittingState.revision);
    base.operationSeq = Math.max(base.operationSeq, submittingState.operationSeq);
    const event = resultEvent(submittingState, eventType,
      eventType === 'SEND_SUCCESS' ? { receiptId: pending.requestId, text: pending.text } : {});
    const finalState = transition(base, event);
    if (eventType === 'SEND_SUCCESS') receipts[pending.requestId] = {
      status: 'SUCCESS', requestId: pending.requestId, letterId: pending.letterId,
      revision: pending.revision, text: pending.text
    };
    try {
      writeEnvelope(finalState, receipts);
      return { ok: eventType === 'SEND_SUCCESS', event,
        ...(eventType === 'SEND_SUCCESS' ? {} : { error: eventType }) };
    } catch (error) {
      // No real service has been called. Atomic local setItem rejection means
      // this attempt did not commit, so its original text can safely be retried.
      return failed(error.message || 'WRITE_ERROR', {
        event: ['CHECK_ERROR', 'SAFETY_BLOCKED'].includes(eventType)
          ? event : resultEvent(submittingState, 'SEND_ERROR')
      });
    }
  }
  function recoverSubmission(state) {
    const pending = currentLetter(state)?.pendingSubmission;
    if (!pending) return load(state);
    try {
      const envelope = readEnvelope();
      const receipt = envelope?.receipts[pending.requestId]
        || Object.values(envelope?.receipts || {}).find(item => item.letterId === pending.letterId);
      if(receipt?.redacted)return failed('REDACTED_REPLY',{stale:true});
      if (receipt) return { ok: true, event: successEvent(state, receipt), recovered: true };
      // A completed read establishes that this local-only store has no commit.
      // Reading does not create a receipt or call commitReply.
      return failed('NO_COMMITTED_REPLY', { event: resultEvent(state, 'SEND_ERROR'), recovered: true });
    } catch (error) {
      return failed(error.message || 'READ_ERROR', { event: resultEvent(state, 'SUBMIT_UNKNOWN') });
    }
  }
  function mutateResponse(ticket){
    let readCompleted=false;
    try{
      if(shouldFail('mutationReadError'))throw new Error('READ_ERROR');
      const envelope=readEnvelope();
      readCompleted=true;
      if(!envelope)throw new Error('MISSING_SNAPSHOT');
      const state=clone(envelope.state),receipts=clone(envelope.receipts);
      const result=applyMutation(state,receipts,ticket);
      if(result.reused)return {ok:true,reused:true,state};
      if(shouldFail('mutationError'))throw new Error('MUTATION_WRITE_ERROR');
      if(shouldFail('mutationUnknownBefore'))return failed('UNKNOWN_RESULT',{unknown:true});
      writeEnvelope(state,receipts);
      if(shouldFail('mutationUnknownAfter'))return failed('UNKNOWN_RESULT',{unknown:true});
      return {ok:true,state};
    }catch(error){return failed(error.message||'MUTATION_ERROR',
      {stale:error.message==='STALE_RESPONSE',unknown:!readCompleted});}
  }
  function recoverMutation(ticket){
    try{
      const envelope=readEnvelope();
      if(!envelope)throw new Error('MISSING_SNAPSHOT');
      const log=envelope.state.mutationLog[ticket.key];
      if(log&&(log.responseId!==ticket.responseId||log.type!==ticket.type||
        log.expectedRevision!==ticket.expectedRevision))throw new Error('MUTATION_KEY_CONFLICT');
      return {ok:true,committed:!!log,state:restoreSnapshot(envelope.state)};
    }catch(error){return failed(error.message||'READ_ERROR',{unknown:true});}
  }
  function redactImportedLegacy({letterId,catId,catName,legacyKey=STORAGE_KEY}){
    try{
      if(!adapter)throw new Error('READ_ERROR');
      const marker=JSON.parse(adapter.getItem(LEGACY_IMPORT_MARKER_KEY)||'null');
      if(marker&&(marker.catId!==catId||marker.catName!==catName||marker.sourceKey!==legacyKey))
        return {ok:true,skipped:true};
      const raw=adapter.getItem(legacyKey);
      if(raw===null)return {ok:true,missing:true};
      const envelope=JSON.parse(raw);
      if(![1,2].includes(envelope?.version)||!validateSnapshot(envelope.state)||
        envelope.state.appearanceId!==catId||envelope.state.catName!==catName||
        !envelope.receipts||typeof envelope.receipts!=='object')throw new Error('INVALID_LEGACY_SNAPSHOT');
      const old=envelope.state.letters[letterId];
      if(!old||old.replySubmitState!=='SUCCESS')return {ok:true,skipped:true};
      if(!marker){
        // PR #12 copied the whole legacy state to the live key without a
        // marker or receipts. Match this one original reply by identity,
        // letter/receipt ID and exact first committed text before redacting.
        const live=readEnvelope(),liveLetter=live?.state.letters[letterId],
          liveResponse=live?.state.responses[liveLetter?.responseId];
        if(!liveLetter||liveLetter.receiptId!==old.receiptId||
          liveResponse?.revisions[0]?.text!==old.submittedText||
          !Object.values(envelope.receipts).some(receipt=>receipt.letterId===letterId&&
            receipt.requestId===old.receiptId&&receipt.text===old.submittedText))
          return {ok:true,skipped:true};
      }
      if(envelope.version===1){
        for(const [id,receipt] of Object.entries(envelope.receipts))if(receipt.letterId===letterId)delete envelope.receipts[id];
        old.submittedText=null;old.receiptId=null;old.replySubmitState='IDLE';old.draft='';old.pendingSubmission=null;
        if(envelope.state.page==='H'&&envelope.state.currentLetterId===letterId)
          envelope.state.page=envelope.state.catState==='TRIP'?'F':'E';
      }else{
        const response=envelope.state.responses[old.responseId];
        if(!response)throw new Error('MISSING_LEGACY_RESPONSE');
        const receipts=clone(envelope.receipts);
        redactResponse(envelope.state,receipts,response);
        envelope.receipts=receipts;
      }
      envelope.state.revision+=1;
      if(!validateSnapshot(envelope.state))throw new Error('INVALID_LEGACY_REDACTION');
      adapter.setItem(legacyKey,JSON.stringify(envelope));
      return {ok:true,redacted:true};
    }catch(error){return failed(error.message||'LEGACY_REDACTION_ERROR');}
  }
  return Object.freeze({ key, load, persist, saveDraft, commitReply, recoverSubmission,mutateResponse,recoverMutation,redactImportedLegacy });
}

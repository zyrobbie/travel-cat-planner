import { initialState, transition, LETTER_FIXTURES, validateSnapshot } from './daily-state.mjs';
import { createDailyStore } from './storage.mjs';

// These are review fixtures, never a source of live user data. Each factory call
// receives a new in-memory Storage object and performs no browser/global writes.
const SIZES = Object.freeze({ M: [390, 844], S: [360, 800], L: [430, 932], D: [1280, 900] });
const BASE = Object.freeze({
  E: 'V1-ui-page-01E-home', F: 'V1-ui-page-01F-travel-home',
  G: 'V1-ui-page-01G-need-card-reply', H: 'V1-ui-page-01H-reply-sent',
});

function scene(page, variant, label, note, { size = 'M', main = false, responsiveMain = false, catState } = {}) {
  const [width, height] = SIZES[size];
  const suffix = main || responsiveMain ? '' : `-state-${variant}`;
  const dimensions = size === 'M' ? '' : `-${size}-${width}x${height}`;
  return Object.freeze({ id: `${page}-${variant}-${size}`, page, label, note,
    file: `${BASE[page]}${suffix}${dimensions}.png`, width, height,
    ...(catState ? { catState } : {}) });
}

// 40 exports: E 10 / F 7 / G 19 / H 4. E-returned-postcard-M also
// covers the F -> E transition; the same picture is not counted twice.
export const SCENARIOS = Object.freeze([
  scene('E', 'empty', '在家 · 今天没有新来信', 'HOME、正常生活、历史入口与两项导航。', { main: true }),
  scene('E', 'new-letter', '在家 · 一封新需求卡', '首页展示不标已读；点击看看来信进入 G。'),
  scene('E', 'returned-postcard', '回家后 · 旅行信仍未读', '由 TRIP 转回 HOME，原明信片入口仍保留；详情留第三批。'),
  scene('E', 'loading', '在家 · 首次加载', '仅静态加载示意，不使用进度百分比或自动创建新猫。'),
  scene('E', 'image-error', '在家 · 图片失败', '保留猫名、生活文字和 3:2 图位，提供原图重试。'),
  scene('E', 'read-error', '在家 · 本机读取失败', '一次隔离读取失败；重试恢复既有猫和数据。'),
  scene('E', 'draft-and-new-letter', '在家 · 旧草稿与新信并存', '旧稿实际写入内存存储，新信优先展示且不覆盖原草稿。'),
  scene('E', 'new-letter', '在家首页 · 紧凑手机', '360×800，完整主图、新信入口与导航。', { size: 'S', responsiveMain: true }),
  scene('E', 'new-letter', '在家首页 · 大屏手机', '430×932，保留 3:2 全幅主图。', { size: 'L', responsiveMain: true }),
  scene('E', 'new-letter', '在家首页 · 桌面', '1280×900，主体居中且最大宽度 620。', { size: 'D', responsiveMain: true }),

  scene('F', 'empty', '旅行中 · 暂无新信', '旅行独立发生，无倒计时、地图、进度或解锁条件。', { main: true }),
  scene('F', 'postcard-arrived', '旅行中 · 明信片到达', 'TRIP 与未读明信片独立；只有一个新信入口。'),
  scene('F', 'postcard-read', '信已读 · 仍在旅行', '仅审阅模型场景；不会把第三批边界说明当成读信。'),
  scene('F', 'image-error', '旅行中 · 图片失败', '原猫的 3:2 旅行图位与轻文案保留。'),
  scene('F', 'postcard-arrived', '旅行首页 · 紧凑手机', '360×800，明信片入口与两项导航完整。', { size: 'S', responsiveMain: true }),
  scene('F', 'postcard-arrived', '旅行首页 · 大屏手机', '430×932，明信片到达不结束旅行。', { size: 'L', responsiveMain: true }),
  scene('F', 'postcard-arrived', '旅行首页 · 桌面', '1280×900，全幅场景与居中主体。', { size: 'D', responsiveMain: true }),

  scene('G', 'empty', '需求卡 · 空回应 / 小提示折叠', '完整原信；空回应不可送出；这次先不回清楚可见。', { main: true }),
  scene('G', 'short-reply', '回应 · 正常短文', '短回应可以正常送出，不要求最低字数。'),
  scene('G', 'long-reply', '回应 · 长文', '自然扩展或滚动，不缩小正文；末行与操作可达。'),
  scene('G', '2000-characters', '回应 · 2000 字边界', '恰好 2000 个字素，内容完整且仍可提交。'),
  scene('G', 'tips-open', '需求卡 · 小提示展开', '辅助提示弱于原信，不替代原正文。'),
  scene('G', 'draft-saving', '草稿 · 保存中', '冻结合法 SAVING 状态；尚未声称已保存。'),
  scene('G', 'draft-saved', '草稿 · 已保存在本机', '实际执行内存 Storage.setItem 后才形成 SAVED。'),
  scene('G', 'draft-error', '草稿 · 保存失败', '一次 draftError 已消耗；原文保留，重试可成功。'),
  scene('G', 'draft-restored', '草稿 · 恢复', '从隔离存储真实读取同一封信的已保存草稿。'),
  scene('G', 'new-letter', '输入中 · 新信到达', '不换当前信、不抢焦点、不清草稿、不自动发送。'),
  scene('G', 'sending', '回应 · 发送中', '冻结合法 SUBMITTING 状态，保留原文并锁定重复提交。'),
  scene('G', 'send-error', '回应 · 发送失败', '一次 sendError 已消耗；显示系统失败并保留原文。'),
  scene('G', 'safety', '回应 · 系统安全处理', '明确标为审阅故障场景，不模拟真实内容判断或心理支持。'),
  scene('G', 'check-error', '回应 · 检查失败', '检查失败与成功分开；原文保留且无成功收据。'),
  scene('G', 'keyboard', '回应 · 紧凑手机键盘展开', '360×800 的审阅键盘示意，不代表真机输入法测试。', { size: 'S' }),
  scene('G', 'focus', '回应 · 聚焦', '补充稿：真实焦点外轮廓，空白仍不可送出。'),
  scene('G', 'overlong', '回应 · 2001 字超长', '补充稿：原文不静默截断，提交不可用。'),
  scene('G', 'empty', '需求卡 · 紧凑手机常规态', '补充稿：360×800，完整原信、文字输入和跳过入口。', { size: 'S', responsiveMain: true }),
  scene('G', 'keyboard', '回应 · 主稿键盘展开', '补充稿：390×844 的审阅键盘示意。'),

  scene('H', 'home', '送出去啦 · 回到在家的小猫', '先实际保存回应和收据，再显示 H；返回 E。', { main: true, catState: 'HOME' }),
  scene('H', 'trip', '送出去啦 · 回到旅行中的小猫', '发送前已是 TRIP，发送本身不改变 CatState；返回 F。', { catState: 'TRIP' }),
  scene('H', 'refresh-error', '已送出 · 后续读取失败', '成功收据已写入；只能重新读取，不得再次发送。', { catState: 'HOME' }),
  scene('H', 'reading', '已送出 · 正在重新读取', '补充稿：保留成功事实，仅冻结后续读取中的视觉。', { catState: 'HOME' }),
]);

const BY_ID = new Map(SCENARIOS.map(item => [item.id, item]));
const SHORT_REPLY = '明天我们再一起等它吧。就算它晚一点来，我也会陪着你。';
const LONG_PARAGRAPH = '小咪，今天我也在窗边坐了一会儿。阳光慢慢移过桌角，杯子旁边留下了一小块亮亮的地方。\n我本来想把它留住，后来觉得，让它慢慢走也很好。明天如果又遇见它，我们就一起看看；没有遇见，也可以听听外面的风。';
const LONG_REPLY = [LONG_PARAGRAPH, '我还看见一片叶子在玻璃外轻轻晃。它没有急着去哪里，我也跟着停了一会儿。', LONG_PARAGRAPH].join('\n\n');
function exactLengthReply(length) {
  const source = Array.from(`${LONG_PARAGRAPH}\n\n`);
  return Array.from({ length }, (_, index) => source[index % source.length]).join('');
}

function isolatedMemory() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  };
}

/**
 * Synchronous, isolated review factory.
 * Returns {state, ui, failFixtures, storageAdapter}. Pass storageAdapter and the
 * SAME failFixtures object to createDailyStore for later review interactions.
 * A displayed error has already consumed its one-shot fixture (value becomes 0),
 * so retry succeeds. Use returned state directly, without an immediate load(),
 * since real restore deliberately clears transient loading/saving conditions.
 */
export function buildScenario(id, { catId = 'cat-01', catName = '小咪' } = {}) {
  const definition = BY_ID.get(id);
  if (!definition) throw new RangeError(`Unknown daily review scenario: ${id}`);
  if (!['cat-01', 'cat-02', 'cat-03', 'cat-04'].includes(catId)) throw new RangeError(`Unknown appearance: ${catId}`);
  const variant = id.slice(2, id.lastIndexOf('-'));
  const storageAdapter = isolatedMemory();
  const failFixtures = {};
  const store = createDailyStore({ storage: storageAdapter, failFixtures });
  const ui = { loading: false, imageError: false, tipsOpen: false, draftRestored: false,
    keyboard: false, freezeState: false, focus: false, reading: false };
  const hasNeed = ['G', 'H'].includes(definition.page)
    || definition.page === 'E' && ['new-letter', 'draft-and-new-letter'].includes(variant);
  let state = initialState({ catId, appearanceId: catId, catName,
    catState: definition.page === 'F' || definition.catState === 'TRIP' ? 'TRIP' : 'HOME',
    initialLetter: hasNeed ? LETTER_FIXTURES['need-01'] : null });

  const dispatch = event => { state = transition(state, event); };
  function persist() {
    const result = store.persist(state);
    if (!result.ok) throw new Error(`Cannot seed ${id}: ${result.error}`);
    state = result.state;
  }
  function applyResult(result, expectedType) {
    if (!result.event || expectedType && result.event.type !== expectedType) {
      throw new Error(`Unexpected ${id} fixture result: ${result.error || result.event?.type || 'missing event'}`);
    }
    dispatch(result.event);
  }
  function openEditor(text = '') {
    dispatch({ type: 'OPEN_NEED', letterId: 'need-01' });
    if (text) dispatch({ type: 'EDIT', value: text });
  }
  function saveDraft({ fail = false } = {}) {
    // The store deliberately preserves its latest navigation when merging a
    // draft. Seed OPEN_NEED/EDIT first, as the real controller does, so saving
    // cannot restore this editor fixture to the earlier home snapshot.
    persist();
    dispatch({ type: 'BEGIN_SAVE' });
    if (fail) failFixtures.draftError = 1;
    applyResult(store.saveDraft(state), fail ? 'SAVE_ERROR' : 'SAVE_SUCCESS');
  }
  function submit(fixture) {
    dispatch({ type: 'BEGIN_SUBMIT' });
    if (fixture) failFixtures[fixture] = 1;
    const expected = { sendError: 'SEND_ERROR', checkError: 'CHECK_ERROR', safetyBlocked: 'SAFETY_BLOCKED' }[fixture] || 'SEND_SUCCESS';
    applyResult(store.commitReply(state), expected);
  }
  function readFailure() {
    // Seed the underlying healthy snapshot before injecting the one failed read.
    persist();
    failFixtures.readError = 1;
    const result = store.load(state);
    if (result.ok || !result.state) throw new Error(`Expected one read failure for ${id}`);
    state = result.state;
  }

  persist();
  if (definition.page === 'E') {
    if (variant === 'returned-postcard') {
      dispatch({ type: 'CAT_TRIP' });
      dispatch({ type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] });
      dispatch({ type: 'CAT_HOME' });
    } else if (variant === 'draft-and-new-letter') {
      openEditor(SHORT_REPLY); saveDraft();
      dispatch({ type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
      dispatch({ type: 'BACK_HOME' }); persist();
      const restored = store.load(state);
      if (!restored.ok) throw new Error(`Cannot restore ${id}`);
      state = restored.state;
    } else if (variant === 'read-error') readFailure();
    ui.loading = variant === 'loading';
    ui.freezeState = ui.loading;
    ui.imageError = variant === 'image-error';
  } else if (definition.page === 'F') {
    if (['postcard-arrived', 'postcard-read'].includes(variant)) {
      dispatch({ type: 'NEW_LETTER', letter: LETTER_FIXTURES['postcard-01'] });
      if (variant === 'postcard-read') dispatch({ type: 'POSTCARD_READ', letterId: 'postcard-01' });
    }
    ui.imageError = variant === 'image-error';
  } else if (definition.page === 'G') {
    const empty = ['empty', 'focus', 'tips-open'].includes(variant);
    const text = variant === 'long-reply' ? LONG_REPLY
      : variant === '2000-characters' ? exactLengthReply(2000)
      : variant === 'overlong' ? exactLengthReply(2001) : empty ? '' : SHORT_REPLY;
    openEditor(text);
    if (variant === 'draft-saving') {
      dispatch({ type: 'BEGIN_SAVE' }); ui.freezeState = true;
    } else if (variant === 'draft-saved') saveDraft();
    else if (variant === 'draft-error') saveDraft({ fail: true });
    else if (variant === 'draft-restored') {
      saveDraft();
      const restored = store.load(state);
      if (!restored.ok) throw new Error(`Cannot restore ${id}`);
      state = restored.state; ui.draftRestored = true;
    } else if (variant === 'new-letter') {
      saveDraft();
      dispatch({ type: 'NEW_LETTER', letter: LETTER_FIXTURES['need-02'] });
      ui.focus = true;
    } else if (variant === 'sending') {
      dispatch({ type: 'BEGIN_SUBMIT' }); ui.freezeState = true;
    } else if (variant === 'send-error') submit('sendError');
    else if (variant === 'safety') submit('safetyBlocked');
    else if (variant === 'check-error') submit('checkError');
    ui.tipsOpen = variant === 'tips-open';
    ui.keyboard = variant === 'keyboard';
    ui.focus ||= variant === 'focus' || ui.keyboard;
  } else if (definition.page === 'H') {
    openEditor(SHORT_REPLY); submit();
    if (['refresh-error', 'reading'].includes(variant)) readFailure();
    if (variant === 'reading') { ui.reading = true; ui.freezeState = true; }
  }
  if (!validateSnapshot(state) || state.page !== definition.page) throw new Error(`Invalid review fixture: ${id}`);
  // Persist all final fixtures so retries/restores operate on the same isolated
  // snapshot. The store preserves already-written success receipts atomically.
  persist();
  return { state, ui, failFixtures, storageAdapter };
}

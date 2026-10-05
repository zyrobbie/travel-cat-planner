// Approved HOME compositions use the original 1536 × 1024 room and its ball.
// No pose choice is written to local storage: one page load chooses once.
export const HOME_POSES = Object.freeze(['sit', 'stretch', 'play-ball']);
const ROOM = Object.freeze({ width: 1536, height: 1024 });
const STRETCH_CONTACTS = Object.freeze([
  [193, 895, 72, 10], [257, 885, 62, 9],
  [521, 915, 76, 10], [554, 896, 70, 9],
]);
const STRETCH_PLACEMENT = Object.freeze({
  left: 139, top: 628, width: 475, contacts: STRETCH_CONTACTS,
});
// The approved stretch previews intentionally use these same four contact
// points for all four sources. The play-ball approvals have individual sizes.
const APPROVED_PLACEMENTS = Object.freeze({
  stretch: Object.freeze({
    'cat-01': STRETCH_PLACEMENT,
    'cat-02': STRETCH_PLACEMENT,
    'cat-03': STRETCH_PLACEMENT,
    'cat-04': STRETCH_PLACEMENT,
  }),
  'play-ball': Object.freeze({
    'cat-01': { left: 400, top: 564, width: 414.72,
      contacts: [[471, 798, 120, 29], [597, 809, 63, 25]] },
    'cat-02': { left: 406, top: 576, width: 399.36,
      contacts: [[486, 806, 103, 26], [609, 811, 65, 26]] },
    'cat-03': { left: 418, top: 575, width: 376.32,
      contacts: [[484, 796, 105, 25], [603, 805, 72, 25]] },
    'cat-04': { left: 433, top: 594, width: 360.96,
      contacts: [[480, 800, 117, 27], [615, 809, 71, 25]] },
  }),
});

export function chooseHomePose(random = Math.random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Invalid pose draw');
  return HOME_POSES[Math.floor(value * HOME_POSES.length)];
}

export function homePoseForNavigation({ catId, navigationType, historyPose, random = Math.random }) {
  if (navigationType === 'back_forward' && historyPose?.catId === catId
    && HOME_POSES.includes(historyPose.pose)) return historyPose.pose;
  return chooseHomePose(random);
}

export function homePosePlacement(catId, pose) {
  const placement = APPROVED_PLACEMENTS[pose]?.[catId];
  if (!placement) throw new Error('Unknown HOME pose or cat');
  return placement;
}

export function homePoseSource(catId, pose, retry = 0) {
  homePosePlacement(catId, pose);
  const url = new URL(`./assets/web/home-poses/${pose}-${catId}-768.webp`, import.meta.url).href;
  return retry ? `${url}?retry=${retry}` : url;
}

const percent = (value, axis) => `${(value / ROOM[axis] * 100).toFixed(8)}%`;
export function homePoseCanvasStyle(placement) {
  return `left:${percent(placement.left, 'width')};top:${percent(placement.top, 'height')};width:${percent(placement.width, 'width')}`;
}
export function homePoseContactStyle([left, top, width, height]) {
  return `left:${percent(left, 'width')};top:${percent(top, 'height')};width:${percent(width, 'width')};height:${percent(height, 'height')}`;
}

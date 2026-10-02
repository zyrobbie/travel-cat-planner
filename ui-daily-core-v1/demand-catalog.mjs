// D-01..D-06 text is copied byte-for-byte from src/content/frozen.json
// (SHA-256 df48989c0e898b4c0df5df2c478524181d7ba76efa6cd22e627d430834a342f7).
// need-01 keeps the previously published light-chasing letter and hint.
export const DEMAND_SEQUENCE=Object.freeze([
  Object.freeze({id:'need-01',eventId:'LIGHT',title:'阳光会在这里等我吗？',
    body:'窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？',
    tip:'可以说说你今天看见的一点小事，也可以只写一句话。\n这次不想回，也没关系。',imageStem:'need-window'}),
  Object.freeze({id:'need-d01',eventId:'D-01',title:'阿橘',
    body:'今天喵了一整天，好累呀！明天不想和阿橘喵了，但我不知道怎么拒绝它，呜呜喵喵 😭',
    tip:'不一定要替它决定明天怎么办。也可以先让它知道：累了、想休息，本身就可以说出来。',imageStem:'demand-D01'}),
  Object.freeze({id:'need-d02',eventId:'D-02',title:'小黑虫子',
    body:'那个小黑虫子好烦人！怎么抓都抓不住，我是不是太笨了呀呜喵 ┭┮﹏┭┮',
    tip:'它现在好像把“没抓到”跟“我很笨”连在一起了。你可以先陪它把这两件事分开。',imageStem:'demand-D02'}),
  Object.freeze({id:'need-d03',eventId:'D-03',title:'小礼物',
    body:'麻麻，我有个小礼物想送给你，但我担心你不喜欢，会觉得它没什么用呜呜~',
    tip:'它好像很在意：这份心意会不会被你喜欢。你可以先回应它的心意，不一定要评价礼物有没有用。',imageStem:'demand-D03'}),
  Object.freeze({id:'need-d04',eventId:'D-04',title:'大橘',
    body:'今天大橘有点伤心，我想安慰它但不知道说什么，怎么办呀麻麻~',
    tip:'安慰不一定要说出一句很厉害的话。有时候，认真陪在旁边也已经是在关心了。',imageStem:'demand-D04'}),
  Object.freeze({id:'need-d05',eventId:'D-05',title:'追泡泡',
    body:'今天看到几只猫在玩追泡泡，好想加入呀，可是它们都不认识我，喵呜…我一直站在旁边没有动，好尴尬呜呜 😢',
    tip:'不用保证它一定会被大家喜欢。也可以陪它想想：有没有一个更小、更舒服的第一步。',imageStem:'demand-D05'}),
  Object.freeze({id:'need-d06',eventId:'D-06',title:'小鱼干',
    body:'今天点心台上有好多种类的小鱼干，我光顾着犹豫选哪个了，最后什么都没吃到，肚子好饿呀喵 😭',
    tip:'选择太多的时候，可以先把第一步变小一点。比如先试一个，不需要一开始就选到“最好”的。',imageStem:'demand-D06'}),
]);

const byId=new Map(DEMAND_SEQUENCE.map(demand=>[demand.id,demand]));
export const demandById=id=>byId.get(id)||null;
export const nextDemandForState=state=>DEMAND_SEQUENCE.find(demand=>!Object.prototype.hasOwnProperty.call(state.letters,demand.id))||null;
export function demandLetter(id,date){
  const demand=demandById(id);
  if(!demand)throw new RangeError(`Unknown demand: ${id}`);
  return {id:demand.id,type:'NEED_CARD',date,title:demand.title,
    data:{contentId:demand.eventId,body:demand.body,tip:demand.tip}};
}
export function demandImageStem(id,appearanceId){
  const demand=demandById(id);
  if(!demand||!/^cat-0[1-4]$/.test(appearanceId))return null;
  return `${demand.imageStem}-${appearanceId}`;
}

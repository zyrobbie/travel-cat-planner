export const cats = [
  {id:'cat-01',name:'橘白',file:'V1-cat-fullbody-cat-01.png'},
  {id:'cat-02',name:'狸花',file:'V1-cat-fullbody-cat-02.png'},
  {id:'cat-03',name:'奶油白',file:'V1-cat-fullbody-cat-03.png'},
  {id:'cat-04',name:'三花',file:'V1-cat-fullbody-cat-04.png'}
];
export const scenarios = [
  {id:'A-empty',page:'A',label:'初始 · 未选择'},
  {id:'A-selected',page:'A',label:'橘白 · 已选择',cat:'cat-01'},
  {id:'A-other',page:'A',label:'三花 · 已选择',cat:'cat-04'},
  {id:'A-image-error',page:'A',label:'图片加载失败',fail:'cat-02'},
  {id:'B-empty',page:'B',label:'空名字',cat:'cat-01',name:''},
  {id:'B-focus',page:'B',label:'输入聚焦',cat:'cat-01',name:'',focus:true},
  {id:'B-filled',page:'B',label:'正常输入',cat:'cat-01',name:'小咪'},
  {id:'B-boundary',page:'B',label:'12 字边界',cat:'cat-01',name:'小橘陪我一起慢慢看看世界'},
  {id:'B-too-long',page:'B',label:'超长错误',cat:'cat-01',name:'小橘陪我一起慢慢看看大世界',error:true},
  {id:'B-empty-error',page:'B',label:'空值校验',cat:'cat-01',name:'',error:true},
  {id:'B-keyboard',page:'B',label:'键盘展开 · 布局示意',cat:'cat-01',name:'小咪',keyboard:true,focus:true},
  {id:'B-restored',page:'B',label:'改选后 · 名字草稿保留',cat:'cat-03',name:'小咪'},
  {id:'C-ready',page:'C',label:'正常确认',cat:'cat-01',name:'小咪'},
  {id:'C-submitting',page:'C',label:'提交中 · 操作锁定',cat:'cat-01',name:'小咪',status:'SUBMITTING'},
  {id:'C-error',page:'C',label:'明确失败 · 可重试',cat:'cat-01',name:'小咪',status:'ERROR'},
  {id:'C-unknown',page:'C',label:'结果未知 · 仅重新读取',cat:'cat-01',name:'小咪',status:'UNKNOWN'},
  {id:'C-reading',page:'C',label:'恢复读取中',cat:'cat-01',name:'小咪',status:'UNKNOWN',reading:true},
  {id:'C-confirmed',page:'C',label:'已确认恢复 · 无改选入口',cat:'cat-01',name:'小咪',status:'CONFIRMED'}
];
export const viewportSpecs = [{id:'M',width:390,height:844},{id:'S',width:360,height:800},{id:'L',width:430,height:932},{id:'D',width:1280,height:900}];

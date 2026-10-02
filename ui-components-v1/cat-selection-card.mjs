const A=new URL('./assets/',import.meta.url);

export const cats=[
  {id:'01',name:'橘白',line:'喜欢晒太阳，也喜欢挨着你。',lineBreak:6},
  {id:'02',name:'狸花',line:'耳朵总是先听见一点新鲜事。',lineBreak:7},
  {id:'03',name:'奶油白',line:'轻轻靠过来，陪你慢一点。',lineBreak:6},
  {id:'04',name:'三花',line:'发现一点小事，就想告诉你。',lineBreak:7}
];

const icons={check:'<path d="m5 12 4 4L19 6"/>'};
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n]}</svg>`;
const image=(name,alt,cls,catId,sources)=>`<img class="${cls}" src="${sources?.src??new URL(name,A).href}"${sources?` srcset="${sources.srcset}" sizes="${sources.sizes}" decoding="async" fetchpriority="${sources.priority??'auto'}"`:''} alt="${alt}" draggable="false" data-cat-image="${catId}">`;

export function choice(i=1,selected=false,group='preview',sources=null) {
  const d=cats[i];
  const intro=group==='all-cats'
    ? `<span class="choice-intro-line">${d.line.slice(0,d.lineBreak)}</span><span class="choice-intro-line">${d.line.slice(d.lineBreak)}</span>`
    : d.line;
  return `<label class="choice-card"><input type="radio" name="${group}" value="${d.name}" ${selected?'checked':''} aria-label="选择${d.name}猫" data-cat-id="cat-${d.id}">${image(`V1-cat-fullbody-cat-${d.id}.png`,d.name+'猫完整全身像','fullbody',`cat-${d.id}`,sources)}<h3>${d.name}</h3><p>${intro}</p><span class="choice-control"><span class="radio-ring">${icon('check')}</span><span class="choice-word">${selected?'已选择':'想认识它'}</span></span></label>`;
}

export function updateChoiceGroup(root,group) {
  root.querySelectorAll('.choice-card input').forEach(input=>{if(input.name===group)input.closest('.choice-card').querySelector('.choice-word').textContent=input.checked?'已选择':'想认识它';});
}

"""One-time extraction of frozen blockquotes, preserving Unicode and paragraph breaks."""
import pathlib,re,json,hashlib,argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source_directory',type=pathlib.Path,help='Frozen 02_原型规格与内容 source directory; not required to run the app')
root=parser.parse_args().source_directory
out=pathlib.Path('src/content');out.mkdir(exist_ok=True)
w=root/'有猫来信_W1核心体验样件与最小规则_V0.4.md';g=root/'有猫来信_W1-G原型内容补齐_V0.1.md'
wt=w.read_text();gt=g.read_text();items=[]
def section(text,start,end): return text.split(start,1)[1].split(end,1)[0]
def quote(text):
    blocks=re.findall(r'^> ?(.*)$',text,re.M)
    return '\n'.join(blocks).strip().replace('  \n','\n')
def add(id,kind,title,body,source,ref,**kw):
    items.append(dict(id=id,version='frozen-20260913-v1',type=kind,title=title,body=body,sha256=hashlib.sha256(body.encode()).hexdigest(),sourceReference=dict(file=source.name,sha256=hashlib.sha256(source.read_bytes()).hexdigest(),section=ref),status='INTERNAL_DRAFT',claimRequirements=[],exclusions=[],sceneId=None,ordinaryFallbackId=None,visualId='internal-placeholder-v1',narrativeSeason=None,**kw))
for i,(s,title) in enumerate([('2.1','阿橘'),('2.2','小黑虫子'),('3.1','小礼物'),('3.2','大橘'),('4.1','追泡泡'),('4.2','小鱼干')],1):
    add(f'D-0{i}','DEMAND',title,quote(section(wt,f'## {s} 日常来信','**假设用户回应：**')),w,s)
for i,(scene,s,title) in enumerate([('RHINE','2.3','我走了另一条路'),('FIREFLY','3.3','抱抱也是礼物'),('LIGHTHOUSE','4.3','灯塔亮起来的时候')]):
    add(f'L-{scene}','LINKED',title,quote(section(wt,f'## {s} 旅行明信片','### 内部核对')),w,s)
    items[-1].update(sceneId=scene,ordinaryFallbackId=f'O-{scene}-01',claimRequirements=[['允许累时休息'],['陪伴表达关心','心意的价值'],['面对新伙伴允许观察和慢慢来']][i])
for scene,title in [('RHINE','山下面有一条亮亮的河'),('FIREFLY','好多小星星飞起来啦'),('LIGHTHOUSE','灯塔一闪一闪的')]:
    add(f'O-{scene}-01','ORDINARY',title,quote(section(gt,f'### Ordinary 明信片 O-{scene}-01','### 为什么 ordinary 合格')),g,f'O-{scene}-01')
    items[-1].update(sceneId=scene,narrativeSeason='初夏' if scene=='FIREFLY' else None)
for i in range(1,7):
    block=section(gt,f'## TIPS-0{i}','设计意图：')
    add(f'TIPS-0{i}','TIP',f'小提示 {i}',quote(block.split('候选：')[1]),g,f'TIPS-0{i}')
# Keep all system quotations as individually addressable, exact source blocks.
sys=section(gt,'# 3. P1–P6 最小系统文案','# 5. 6 张需求卡')
for i,m in enumerate(re.finditer(r'(?:^>.*(?:\n|$))+',sys,re.M),1):
    if i==32: continue # Source says 不设置: prohibited examples, never usable copy.
    add(f'SYS-{i:03}','SYSTEM',f'系统词条 {i}',quote(m.group()),g,f'系统词条 block {i}')
for item in items:
    if item['sceneId']:
        item['narrativeSeason']='初夏' if item['sceneId']=='FIREFLY' else None
        item['timeOfDay']='夜晚' if item['sceneId']=='FIREFLY' else '傍晚'
(out/'frozen.json').write_text(json.dumps(dict(version='frozen-20260913-v1',items=items),ensure_ascii=False,indent=2)+'\n')
print({k:sum(x['type']==k for x in items) for k in set(x['type'] for x in items)})

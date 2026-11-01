import json
S=json.load(open('tools/script.json'));t=0.05;lines=[]
for k,v in S.items():
    ws=v.split();d=len(ws)/2.7;words=[]
    for i,w in enumerate(ws): words.append({'w':w,'s':round(t+i*d/len(ws),3),'e':round(t+(i+1)*d/len(ws),3)})
    lines.append({'id':k,'start':round(t,3),'end':round(t+d,3),'text':v,'words':words});t+=d+0.15
open('vo.js','w').write('window.VO='+json.dumps({'lines':lines})+';')
print(round(t,2))

import json,sys,urllib.request,os
U='http://127.0.0.1:27182/mcp'
SF=os.path.join(os.path.dirname(__file__),'.sid')
def post(body,sid=None):
    h={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
    if sid:h['Mcp-Session-Id']=sid
    r=urllib.request.urlopen(urllib.request.Request(U,json.dumps(body).encode(),h),timeout=600)
    t=r.read().decode();s=r.headers.get('Mcp-Session-Id')
    for l in t.splitlines():
        if l.startswith('data:'):t=l[5:]
    return (json.loads(t) if t.strip() else None),s
def sess():
    if os.path.exists(SF):return open(SF).read()
    _,s=post({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'cc','version':'1'}}})
    post({'jsonrpc':'2.0','method':'notifications/initialized'},s);open(SF,'w').write(s);return s
def call(name,args):
    s=sess()
    try:r,_=post({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':args}},s)
    except urllib.error.HTTPError as e:
        os.remove(SF);s=sess();r,_=post({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':args}},s)
    return r
if __name__=='__main__':
    if sys.argv[1]=='list':
        s=sess();r,_=post({'jsonrpc':'2.0','id':3,'method':'tools/list'},s);print([t['name'] for t in r['result']['tools']])
    else:
        code=open(sys.argv[1]).read()
        r=call('fusion_mcp_execute',{'featureType':'script','object':{'script':code}})
        for c in r.get('result',{}).get('content',[]):print(c.get('text'))
        if 'error' in r:print(r['error'])

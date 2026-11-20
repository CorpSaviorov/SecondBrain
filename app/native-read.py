"""Deterministic local-to-canonical projection. Never writes a transcript to Obsidian."""
import hashlib, json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent/'python'))
from intake import read_snapshot
request=json.load(sys.stdin)
provider=request['provider']
settings=request['config']
config={'sources':[{'root':p,'format':settings['format']} for p in settings['roots']],'quiet_seconds':settings.get('quiet_seconds',300)}
previous=request.get('checkpoint',{})
result={'sources':[], 'deferred':0, 'errors':[], 'skipped_nonconversations':0, 'checkpoint':dict(previous)}
for source in config['sources']:
    root=Path(source['root'])
    if not root.is_dir(): continue
    for p in root.rglob('*.jsonl'):
        if p.is_symlink() or any(x in ('subagents','node_modules','.git') for x in p.relative_to(root).parts): continue
        stat=p.stat()
        signature=[str(stat.st_mtime_ns),str(stat.st_size)]
        if previous.get(str(p))==signature: continue
        if time.time()-stat.st_mtime < config['quiet_seconds']:
            result['deferred']+=1; continue
        try:
            raw,snapshot=read_snapshot(p, source['format'])
            if p.stat().st_mtime_ns!=stat.st_mtime_ns or p.stat().st_size!=stat.st_size: raise ValueError('source changed')
            messages=[{k:m[k] for k in ('id','role','text','time') if k in m} for m in snapshot['messages']]
            body='\n\n'.join('## '+m['role']+' · '+m['id']+'\n'+('Дата: '+str(m['time'])+'\n' if m.get('time') else '')+'\n'+m['text'] for m in messages)
            first=json.loads(raw.decode('utf-8-sig').split('\n',1)[0])
            cwd=first.get('payload',{}).get('cwd') or first.get('cwd')
            result['sources'].append(dict(provider=snapshot['source'], external_id=snapshot['source_id'],title=snapshot['source']+' · '+snapshot['source_id'],messages=messages,body=body,raw_hash=hashlib.sha256(raw).hexdigest(),source_path=str(p).replace('\\','/'),coverage=snapshot['coverage'],metadata={'direct_local':True,**({'project_directory':cwd} if cwd else {})}))
            result['checkpoint'][str(p)]=signature
        except (ValueError,KeyError,TypeError,OSError) as e:
            # Service sessions are intentionally not treated as user conversations.
            if 'Subagent/guardian' in str(e) or str(e)=='No source messages; summaries are insufficient':
                result['skipped_nonconversations']+=1
                result['checkpoint'][str(p)]=signature
            else: result['errors'].append({'file':p.name,'error':type(e).__name__})
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))

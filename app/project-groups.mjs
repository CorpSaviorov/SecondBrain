import path from 'node:path';
import {createHash} from 'node:crypto';
export const projectId=name=>'project:'+createHash('sha256').update(name.toLowerCase().trim()).digest('hex').slice(0,14);
// Folder-name aliases for project hubs. Add your own: {'folder-name':'Display name'}.
const aliases={};
const normal=s=>aliases[s.toLowerCase()]||s;
// Which mailbox an e-mail record came from, by the account address (user: show that the mail is Yandex).
export const mailService=account=>{const d=String(account||'').split('@')[1]?.toLowerCase()||'';return /(^|.)(yandex.(ru|com|by|kz|ua)|ya.ru|narod.ru)$/.test(d)?{key:'yandex',name:'Яндекс Почта'}:/(^|.)(gmail|googlemail).com$/.test(d)?{key:'gmail',name:'Gmail'}:d?{key:d,name:'Почта '+d}:{key:'mail',name:'Почта'};};
export function projectGroup(doc,assignment){
 if(assignment)return {id:assignment.project_id,label:assignment.name,type:'project',basis:'manual'};
 const meta=typeof doc.metadata==='string'?JSON.parse(doc.metadata):doc.metadata||{},p=(doc.source_path||'').replaceAll('\\','/');
 if(meta.project_name)return {id:projectId(meta.project_name),label:meta.project_name,type:'project',basis:'source-metadata'};
 if(meta.project_directory){const label=path.posix.basename(meta.project_directory.replaceAll('\\','/'));return {id:projectId(label),label,type:'project',basis:'session-project-directory'};}
 let name=p.match(/\/Chat\/([^/]+)\//)?.[1]||p.match(/(?:^|\/)(?:Projects|Проекты)\/([^/]+)\//i)?.[1];
 if(name&&!/^(recent|main|recents)$/i.test(name)){name=normal(name);return {id:projectId(name),label:name,type:'project',basis:'source-folder'};}
 const library=p.match(/\/raw\/library\/([^/]+)\//i)?.[1];
 if(library){name=normal(library);return {id:projectId(name),label:name,type:'project',basis:'library-folder'};}
 const wiki=p.match(/\/wiki\/chat-project-([^/.]+)\.md$/i)?.[1];
 if(wiki&&aliases[wiki.toLowerCase()]){name=normal(wiki);return {id:projectId(name),label:name,type:'project',basis:'wiki-project-file'};}
 const local=p.match(/\/\.claude\/projects\/([^/]+)\//)?.[1];
 if(local){name=local.split(/-Desktop-|-Documents-/i).at(-1).replace(/-/g,' ');return {id:projectId(name),label:name,type:'project',basis:'session-folder'};}
 const buckets={chatgpt:['Разговоры без проекта','chatgpt'],claude:['Разговоры Claude без проекта','claude'],obsidian:['Заметки и Wiki','obsidian'],codex:['Сессии Codex','codex'],'claude-code':['Сессии Claude Code','claude-code'],email:['Почта','email'],telegram:['Telegram','telegram']};
 if(doc.provider==='email'){const m=mailService(doc.account);return {id:'bucket:email-'+m.key,label:m.name,type:'collection',basis:'provider-without-project'};}
 const [label,key]=buckets[doc.provider]||['Другие материалы',doc.provider];
 return {id:'bucket:'+key,label,type:'collection',basis:'provider-without-project'};
}

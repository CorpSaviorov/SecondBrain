import path from 'node:path';
import {createHash} from 'node:crypto';
export const projectId=name=>'project:'+createHash('sha256').update(name.toLowerCase().trim()).digest('hex').slice(0,14);
// One spelling per project: the same project can arrive as a ChatGPT project, a folder or a session directory.
const aliases={};
// Add your own spellings: {'folder-or-project-name':'Display name'}.
const normal=s=>aliases[String(s).toLowerCase().trim()]||String(s).trim();
// Native names that are ids, encoded paths or temporary folders, not projects (2026-11-27): such records are placed by
// automatic projects instead of showing «g-p-…», «C--Users-…» or a working folder («Obsidian Vault») as a project.
export const junkProject=s=>/^g-p-[0-9a-f]{16,}$/i.test(s)||/^(obsidian vault|vault|documents|desktop|downloads|projects|work|practice|tmp|temp|codex)$/i.test(String(s).trim())||/^referenced-chatgpt-conversation/i.test(s)||/scratch[-\s]workspaces|AppData[-\s]Local[-\s]Claude|^[A-Z][-\s]+Users[-\s]/i.test(s);
// Which mailbox an e-mail record came from, by the account address (user: show that the mail is Yandex).
export const mailService=account=>{const d=String(account||'').split('@')[1]?.toLowerCase()||'';return /(^|.)(yandex.(ru|com|by|kz|ua)|ya.ru|narod.ru)$/.test(d)?{key:'yandex',name:'Яндекс Почта'}:/(^|.)(gmail|googlemail).com$/.test(d)?{key:'gmail',name:'Gmail'}:d?{key:d,name:'Почта '+d}:{key:'mail',name:'Почта'};};
// The project a record carries by itself (ChatGPT project, session directory, folder), or null.
function nativeProject(doc){
 const meta=typeof doc.metadata==='string'?JSON.parse(doc.metadata||'{}'):doc.metadata||{},p=(doc.source_path||'').replaceAll('\\','/');
 if(meta.project_name)return [meta.project_name,'source-metadata'];
 if(meta.project_directory)return [path.posix.basename(meta.project_directory.replaceAll('\\','/')),'session-project-directory'];
 const name=p.match(/\/Chat\/([^/]+)\//)?.[1]||p.match(/(?:^|\/)(?:Projects|Проекты)\/([^/]+)\//i)?.[1];
 if(name&&!/^(recent|main|recents)$/i.test(name))return [name,'source-folder'];
 const library=p.match(/\/raw\/library\/([^/]+)\//i)?.[1];
 if(library)return [library,'library-folder'];
 const wiki=p.match(/\/wiki\/chat-project-([^/.]+)\.md$/i)?.[1];
 if(wiki&&aliases[wiki.toLowerCase()])return [wiki,'wiki-project-file'];
 const local=p.match(/\/\.claude\/projects\/([^/]+)\//)?.[1];
 if(local)return [local.split(/-Desktop-|-Documents-/i).at(-1).replace(/-/g,' '),'session-folder'];
 return null;
}
export function nativeProjectName(doc){const n=nativeProject(doc);return n&&!junkProject(n[0])?normal(n[0]):null;}
// Order: the owner's manual choice, then the record's own project, then the automatic project, then a provider bucket.
export function projectGroup(doc,assignment,auto=null){
 if(assignment)return {id:assignment.project_id,label:assignment.name,type:'project',basis:'manual'};
 const n=nativeProject(doc);
 if(n&&!junkProject(n[0])){const label=normal(n[0]);return {id:projectId(label),label,type:'project',basis:n[1]};}
 if(auto)return {id:projectId(auto),label:auto,type:'project',basis:'auto'};
 const buckets={chatgpt:['Разговоры без проекта','chatgpt'],claude:['Разговоры Claude без проекта','claude'],obsidian:['Заметки и Wiki','obsidian'],codex:['Сессии Codex','codex'],'claude-code':['Сессии Claude Code','claude-code'],email:['Почта','email']};
 if(doc.provider==='email'){const m=mailService(doc.account);return {id:'bucket:email-'+m.key,label:m.name,type:'collection',basis:'provider-without-project'};}
 const [label,key]=buckets[doc.provider]||['Другие материалы',doc.provider];
 return {id:'bucket:'+key,label,type:'collection',basis:'provider-without-project'};
}

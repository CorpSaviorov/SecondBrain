import {test} from 'node:test';import assert from 'node:assert/strict';
import {maskSecrets,mask} from './lib/secrets.mjs';import {freezeSource} from './card-packets.mjs';
const S={openai:'sk-proj-'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',ant:'sk-ant-api03-'+'abcDEF123456ghiJKL789012mno',gh:'ghp_'+'abcdefghijklmnopqrstuvwxyz0123456789',aws:'AKIA'+'ABCDEFGHIJKLMNOP',google:'AIza'+'SyA1234567890abcdefghijklmnopqrstuv',tg:'123456789:AA'+'Hk3jd8sKd9LmQwErTyUiOpAsDfGhJkLzXcV',jwt:'eyJhbGciOiJIUzI1NiJ9.'+'eyJzdWIiOiIxMjM0NTY3ODkwIn0.'+'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'};
test('known credential shapes are masked with a readable label',()=>{for(const [k,v] of Object.entries(S)){const r=maskSecrets(`ключ: ${v} конец`);assert.ok(!r.text.includes(v),k);assert.match(r.text,/\[скрыто/);assert.equal(r.count>=1,true,k);}
 assert.equal(mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'),'Authorization: Bearer [скрыто: токен]');
 assert.equal(mask('password=Qwerty123!'),'password=[скрыто]');assert.equal(mask('пароль: s3cretPass'),'пароль: [скрыто]');
 assert.ok(!mask('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----').includes('MIIEow'));});
test('hashes, UUIDs and ordinary prose are left alone',()=>{const keep=['revision 84dc2d18380eefa2bd779d951f23b39efb31b5f0bc6697fe26298e366eb75f56','id 01a1b870-bc0b-7430-ae74-5f73ad4a3375','токен — это единица текста для модели','password: нужно придумать','skill-creator и sk-короткий','tokens: 8687'];for(const s of keep)assert.equal(mask(s),s,s);});
test('masking a serialized JSON payload keeps it valid JSON',()=>{const v={a:`token=${'abcd1234efgh5678'}`,b:S.openai,c:['ok',S.jwt],k:'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'};const out=mask(JSON.stringify(v)),p=JSON.parse(out);assert.ok(!out.includes(S.openai));assert.equal(p.b,'[скрыто: ключ OpenAI]');assert.ok(p.k.includes('[скрыто'));});
test('Luna packets are built from masked text, so quotes are checked against what the model saw',()=>{const s=freezeSource({id:'chatgpt:s',revision:'r',kind:'chat',source_path:null},{body:'',messages:JSON.stringify([{id:'m1',role:'user',text:`Мой ключ ${S.openai}, проверь подключение.`}])});assert.ok(!s.text.includes(S.openai));assert.ok(s.text.includes('[скрыто: ключ OpenAI]'));});
test('base64 attachments and data: images are hidden; prose, hashes and short tokens stay',async()=>{
 const {hideBinary}=await import('./lib/secrets.mjs');
 const line='QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3';
 const blob=Array(6).fill(line).join('\r\n')+'\r\nQUJD==\r\n';
 const t=mask('Привет!\r\n'+blob+'С уважением, Иван');assert.match(t,/Привет!\r\n\[скрыто: двоичные данные\]\r?\n?С уважением, Иван/);
 assert.equal(hideBinary('<img src="data:image/png;base64,'+'A'.repeat(200)+'">'),'<img src="[скрыто: двоичные данные]">');
 const sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';assert.equal(hideBinary('hash '+sha),'hash '+sha);
 const prose='Обычный длинный текст письма без кодировок, где много слов и пробелов. '.repeat(20);assert.equal(hideBinary(prose),prose);});

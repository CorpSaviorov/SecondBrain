import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mailSetupUrls,openMailSetup} from './connectors/mail-browser.mjs';
test('external mail setup opens only the official provider app-password page, with no credentials in URLs',async()=>{
 const c={id:'email-yandex',driver:'imap-mail',config:{service:'yandex',address:'private@example.test',password:'not-a-real-key'}};const opened=[];await openMailSetup(c,{platform:'win32',open:async url=>opened.push(url)});assert.deepEqual(opened,['https://passport.yandex.ru/security/app-passwords']);assert.ok(!JSON.stringify(opened).includes('private'));assert.throws(()=>mailSetupUrls({...c,config:{service:'https://other.test'}}));assert.throws(()=>mailSetupUrls({...c,id:'arbitrary'}));await assert.deepEqual(await openMailSetup(c,{platform:'other',open:async()=>{throw Error('must not run');}}).then(r=>[r.opened,r.url]),[false,'https://passport.yandex.ru/security/app-passwords']);
});

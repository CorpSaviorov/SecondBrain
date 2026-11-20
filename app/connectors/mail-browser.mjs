import {spawn} from 'node:child_process';
export function mailSetupUrls(c){
 const pages={yandex:'https://passport.yandex.ru/security/app-passwords',gmail:'https://myaccount.google.com/apppasswords'};
 if(c?.driver!=='imap-mail'||!pages[c.config?.service]||!/^email-(gmail|yandex)$/.test(c.id))throw Error('Неизвестное почтовое подключение');
 return [pages[c.config.service]];
}
async function openWindowsUrl(url){await new Promise((resolve,reject)=>{const child=spawn('explorer.exe',[url],{windowsHide:true,stdio:'ignore',detached:true});child.once('error',()=>reject(Error('Не удалось открыть обычный браузер')));child.once('spawn',()=>{child.unref();resolve();});});}
export async function openMailSetup(c,{platform=process.platform,open=openWindowsUrl}={}){const urls=mailSetupUrls(c);if(platform!=='win32')return {opened:false,url:urls[0],message:'Открываю страницу паролей приложений в вашем браузере. Создайте пароль и вставьте его в карточку почты.'};for(const url of urls)await open(url);return {opened:true,message:c.config.service==='gmail'?'Открыта страница «Пароли приложений» Google в вашем браузере. Создайте пароль «SecondBrain», скопируйте 16 букв и вставьте в карточку Gmail.':'Открыта страница паролей приложений Яндекса в вашем браузере. Создайте пароль для «Почта», скопируйте и вставьте в карточку.'};}

// Deterministic Russian Snowball stemming; no model, package or network calls.
// Algorithm specification: https://snowballstem.org/algorithms/russian/stemmer.html
export const normalize=text=>text.normalize('NFKC').toLowerCase();
export const words=text=>normalize(text).match(/[\p{L}\p{N}]+/gu)||[];
export const normalizePhrase=text=>words(text).join(' ');
const vowel=/[аеиоуыэюя]/;
const suffixes=text=>text.split(' ').sort((a,b)=>b.length-a.length);
const perfective=suffixes('в вши вшись ив ивши ившись ыв ывши ывшись');
const perfectiveConditional=new Set(['в','вши','вшись']);
const adjective=suffixes('ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею');
const participle=suffixes('ем нн вш ющ щ ивш ывш ующ');
const participleConditional=new Set(['ем','нн','вш','ющ','щ']);
const verb=suffixes('ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно ила ыла ена ейте уйте ите или ыли ей уй ил ыл им ым ен ило ыло ено ят ует уют ит ыт ены ить ыть ишь ую ю');
const verbConditional=new Set(suffixes('ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно'));
const noun=suffixes('а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я');
function region(word,start){
 for(let i=start+1;i<word.length;i++)if(vowel.test(word[i-1])&&!vowel.test(word[i]))return i+1;
 return word.length;
}
const cache=new Map();
export function russianStem(token){
 const original=normalize(token);
 if(!/^[а-яё]+$/u.test(original)||original.length>8192)return original;
 const cached=cache.get(original);if(cached!==undefined)return cached;
 let word=original.replace(/ё/g,'е');
 const first=word.search(vowel),rv=first<0?word.length:first+1,r2=region(word,region(word,0));
 function remove(list,boundary=rv,conditional){
  // Snowball selects the longest ending before checking its context.
  const suffix=list.find(s=>word.endsWith(s)&&word.length-s.length>=boundary);
  if(!suffix)return false;
  const start=word.length-suffix.length;
  if(conditional?.has(suffix)&&(start<=boundary||!/[ая]/.test(word[start-1])))return false;
  word=word.slice(0,start);return true;
 }
 if(!remove(perfective,rv,perfectiveConditional)){
  remove(['ся','сь']);
  if(remove(adjective))remove(participle,rv,participleConditional);
  else if(!remove(verb,rv,verbConditional))remove(noun);
 }
 remove(['и']);
 remove(['ость','ост'],r2);
 if(word.endsWith('нн')&&word.length-2>=rv)word=word.slice(0,-1);
 else if(remove(['ейше','ейш'])){
  if(word.endsWith('нн')&&word.length-2>=rv)word=word.slice(0,-1);
 }else remove(['ь']);
 if(cache.size>=8192)cache.delete(cache.keys().next().value);
 cache.set(original,word);return word;
}
// This namespace cannot collide with tokens extracted from user text.
export const searchTerm=token=>/^[а-яё]+$/u.test(token)?'~ru:'+russianStem(token):token;
export const indexTerms=token=>{const stem=searchTerm(token);return stem===token?[token]:[token,stem];};

import {words,normalizePhrase} from './lexical.mjs';
export function parseQuery(query) {
  if (typeof query !== 'string' || query.length < 2 || query.length > 200)
    throw new Error('Query must contain 2–200 characters');
  const terms = [...new Set(words(query))];
  if (!terms.length) throw new Error('Query must contain words or numbers');
  const phrases = [...query.matchAll(/"([^"\n]+)"/g)].map(m => normalizePhrase(m[1])).filter(Boolean);
  return {terms, phrases, phrase: normalizePhrase(query)};
}


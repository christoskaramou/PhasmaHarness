const STOP = new Set('a an the and or in on at to for from of is are was were be can could would should how what where which why does do it its this that with as by we i my our me please find show relevant project context code implementation explain'.split(' '));

function tokens(text) {
  return (String(text).normalize('NFKC').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(w => !STOP.has(w))
    .map(w => w.length > 4 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
}

function terms(text) {
  const counts = new Map();
  for (const word of tokens(text)) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}

function rank(query, documents) {
  const queryTerms = [...new Set(tokens(query))].slice(0, 24);
  const df = new Map(queryTerms.map(t => [t, documents.filter(d => d.terms.has(t) || d.pathTerms.has(t)).length]));
  const average = documents.reduce((sum, d) => sum + d.length, 0) / (documents.length || 1) || 1;
  const atoms = text => new Set(String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+(?:[./-][\p{L}\p{N}_]+)*/gu) || []);
  const exact = [...atoms(query)].filter(w => w.length > 1 && tokens(w).length).slice(0, 24);
  const phrases = [...String(query).matchAll(/["`](.*?)["`]/g)].map(m => tokens(m[1]));
  const whole = tokens(query);
  if (whole.length >= 2 && whole.length <= 8) phrases.push(whole);
  const phraseMatch = (text, phrase) => ` ${tokens(text).join(' ')} `.includes(` ${phrase.join(' ')} `);
  return documents.map(d => {
    let localScore = 0, lexicalScore = 0, matched = 0;
    for (const term of queryTerms) {
      const tf = d.terms.get(term) || 0;
      const idf = Math.log(1 + (documents.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      if (tf || d.pathTerms.has(term)) matched++;
      lexicalScore += tf;
      if (tf) localScore += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.length / average));
      if (d.pathTerms.has(term)) localScore += 2 * idf;
    }
    if (!matched) return { ...d, localScore: 0, lexicalScore };
    const nameAtoms = atoms(d.path), textAtoms = atoms(d.text);
    for (const atom of exact) {
      if (nameAtoms.has(atom) || d.path.split('/').pop().toLowerCase() === atom) localScore += 3;
      else if (textAtoms.has(atom) && /[_./-]|[A-Z].*[A-Z]|[a-z][A-Z]/.test(String(query))) localScore += 1;
    }
    for (const phrase of phrases.filter(p => p.length >= 2)) {
      if (phraseMatch(d.path, phrase)) localScore += 3;
      if (phraseMatch(d.text, phrase)) localScore += 2;
    }
    // Coverage makes a multi-term match beat incidental mentions of just one term.
    localScore *= matched / queryTerms.length;
    return { ...d, localScore, lexicalScore };
  });
}

module.exports = { tokens, terms, rank };

// Finds numbers in what a caller says: digits in Latin, Devanagari or Gujarati script, and spoken
// number words in Hindi, Marathi, Gujarati and English (typed in their own script or in Latin letters).

const DIGIT_BLOCKS = [0x0966 /* Devanagari ० */, 0x0ae6 /* Gujarati ૦ */];

export function normaliseDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const block = DIGIT_BLOCKS.find((b) => c >= b && c <= b + 9);
    out += block !== undefined ? String(c - block) : ch;
  }
  return out;
}

/** Plain number words. Ambiguous Latin words ("do", "be", "so", "saath") are left out or handled below. */
const WORDS: Record<string, number> = {};
const add = (n: number, ...ws: string[]) => { for (const w of ws) WORDS[w] = n; };

// English
add(1, "one"); add(2, "two"); add(3, "three"); add(4, "four"); add(5, "five"); add(6, "six"); add(7, "seven"); add(8, "eight");
add(9, "nine"); add(10, "ten"); add(11, "eleven"); add(12, "twelve"); add(15, "fifteen"); add(20, "twenty"); add(25, "twenty-five");
add(30, "thirty"); add(40, "forty"); add(50, "fifty"); add(60, "sixty"); add(70, "seventy"); add(80, "eighty"); add(90, "ninety");
// Hindi, Latin letters
add(1, "ek"); add(3, "teen", "tin"); add(4, "char", "chaar"); add(5, "paanch", "panch", "paach"); add(6, "chhe", "chhah", "chah");
add(7, "saat"); add(8, "aath"); add(9, "nau"); add(10, "das"); add(11, "gyarah"); add(12, "barah", "baarah", "bara"); add(13, "terah");
add(14, "chaudah"); add(15, "pandrah"); add(16, "solah"); add(17, "satrah"); add(18, "atharah"); add(19, "unnees", "unnis");
add(20, "bees", "bis"); add(25, "pachees", "pachis", "pachchis"); add(30, "tees", "tis"); add(40, "chalees", "chalis");
add(50, "pachaas", "pachas"); add(70, "sattar"); add(80, "assi"); add(90, "nabbe"); add(1.5, "dedh", "dedh"); add(2.5, "dhai", "dhaai");
// Hindi, Devanagari
add(1, "एक"); add(2, "दो"); add(3, "तीन"); add(4, "चार"); add(5, "पांच", "पाँच"); add(6, "छह", "छः", "छे"); add(7, "सात");
add(8, "आठ"); add(9, "नौ"); add(10, "दस"); add(11, "ग्यारह"); add(12, "बारह"); add(13, "तेरह"); add(14, "चौदह"); add(15, "पंद्रह");
add(16, "सोलह"); add(17, "सत्रह"); add(18, "अठारह"); add(19, "उन्नीस"); add(20, "बीस"); add(25, "पच्चीस"); add(30, "तीस");
add(40, "चालीस"); add(50, "पचास"); add(60, "साठ"); add(70, "सत्तर"); add(80, "अस्सी"); add(90, "नब्बे"); add(1.5, "डेढ़", "डेढ"); add(2.5, "ढाई");
// Marathi (Devanagari and Latin)
add(2, "दोन", "don"); add(5, "पाच"); add(6, "सहा", "saha"); add(9, "नऊ"); add(10, "दहा", "daha"); add(11, "अकरा"); add(12, "बारा");
add(13, "तेरा"); add(14, "चौदा"); add(15, "पंधरा"); add(16, "सोळा"); add(17, "सतरा"); add(18, "अठरा"); add(19, "एकोणीस");
add(20, "वीस", "vees"); add(25, "पंचवीस", "panchvis"); add(40, "चाळीस"); add(50, "पन्नास", "pannas"); add(80, "ऐंशी"); add(90, "नव्वद");
// Gujarati (Gujarati script and Latin)
add(1, "એક"); add(2, "બે"); add(3, "ત્રણ", "tran"); add(4, "ચાર"); add(5, "પાંચ"); add(6, "છ"); add(7, "સાત"); add(8, "આઠ"); add(9, "નવ");
add(10, "દસ"); add(11, "અગિયાર"); add(12, "બાર"); add(13, "તેર"); add(14, "ચૌદ"); add(15, "પંદર"); add(16, "સોળ"); add(17, "સત્તર");
add(18, "અઢાર"); add(19, "ઓગણીસ"); add(20, "વીસ", "vis"); add(25, "પચ્ચીસ"); add(30, "ત્રીસ"); add(40, "ચાલીસ"); add(50, "પચાસ");
add(60, "સાઠ"); add(70, "સિત્તેર"); add(80, "એંસી"); add(90, "નેવું"); add(1.5, "દોઢ"); add(2.5, "અઢી");

const MULTIPLIERS: Record<string, number> = {
  hundred: 100, sau: 100, "सौ": 100, shambhar: 100, "शंभर": 100, "સો": 100,
  thousand: 1000, hazaar: 1000, hazar: 1000, hajar: 1000, hajaar: 1000, "हज़ार": 1000, "हजार": 1000, "હજાર": 1000,
  lakh: 100000, lac: 100000, "लाख": 100000, "લાખ": 100000,
};
/** Words that are numbers only right after another number ("do sau" = 200, but "do" alone is often English). */
const AFTER_NUMBER: Record<string, number> = { so: 100 };
const LEAD_ONLY: Record<string, number> = { do: 2, be: 2 };

export function tokens(s: string): string[] {
  return normaliseDigits(s.toLowerCase())
    .replace(/(\d),(\d)/g, "$1$2") // 1,000 → 1000
    .split(/[^\p{L}\p{M}\d.\-]+/u)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter(Boolean);
}

function value(tok: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(tok)) return Number(tok);
  return WORDS[tok];
}

/** Every number mentioned, in order. "do sau pachaas" → [250]; "50 carton" → [50]; "2.5 lakh" → [250000]. */
export function findNumbers(text: string): number[] {
  const toks = tokens(text);
  const out: number[] = [];
  let total = 0, cur = 0, inNum = false;
  const flush = () => { if (inNum) out.push(round(total + cur)); total = 0; cur = 0; inNum = false; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const v = value(t);
    const mult = MULTIPLIERS[t] ?? (inNum ? AFTER_NUMBER[t] : undefined);
    const lead = LEAD_ONLY[t];
    const nextIsMult = i + 1 < toks.length && (MULTIPLIERS[toks[i + 1]] !== undefined || AFTER_NUMBER[toks[i + 1]] !== undefined);
    if (v !== undefined) {
      if (inNum && cur !== 0 && !(cur >= 100 || v < cur)) flush(); // "50 50" are two numbers; "sau pachaas" is one
      cur += v; inNum = true;
    } else if (mult !== undefined) {
      cur = (cur || 1) * mult; inNum = true;
      if (mult >= 1000) { total += cur; cur = 0; }
    } else if (lead !== undefined && nextIsMult) {
      cur += lead; inNum = true;
    } else flush();
  }
  flush();
  return out;
}

/** True for a token that can be part of a spoken or written number. */
export function isNumberToken(t: string): boolean {
  return value(t) !== undefined || MULTIPLIERS[t] !== undefined || AFTER_NUMBER[t] !== undefined || LEAD_ONLY[t] !== undefined;
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

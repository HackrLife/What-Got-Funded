// Multilingual funding keywords: a cheap first pass so only likely funding articles are fetched.
export const FUNDING_RE = new RegExp(
  [
    "\\brais(e|es|ed|ing)\\b", "\\bfunding\\b", "fundrais", "\\bseries [a-h]\\b", "\\bseed\\b", "pre-seed", "\\bround\\b", "\\binvest(s|ed|ment|ors?)\\b", "\\bbacked\\b",
    "\\bsecures?\\b", "\\bbags?\\b", "\\bcloses?\\b", "\\bnabs?\\b", "\\blands?\\b", "\\$\\s?\\d", "€\\s?\\d", "£\\s?\\d", "\\d+(\\.\\d+)?\\s?(m|mn|million|bn|billion|crore|lakh)\\b",
    "資金調達", "億円", "シリーズ", "出資", "투자", "유치", "억원", "融资", "轮", "亿元", "万元", "天使轮",
    "finanzierung", "millionen", "investiert", "levée", "lève", "levé", "ronda", "inversión", "financiación", "recauda", "levanta", "rodada", "aporte", "capta",
    "investimento", "finanziamento", "raccoglie", "investering", "rahoitus", "kapitalrunde", "financiering", "haalt", "инвестиц", "раунд", "pendanaan", "gọi vốn", "vốn",
    "ระดมทุน", "निवेश", "फंडिंग", "تمويل", "جولة", "גיוס", "השקעה", "yatırım", "finansowanie", "investice", "rundă", "befektetés",
  ].join("|"),
  "i",
);

// Headlines that are almost never a startup round, to save fetches
export const NOT_ROUND_RE = /\b(ipo|listing|lists on|files to go public|acquires?|acquisition|merger|layoffs?|earnings|quarterly results|dividend|bond|loan|debt facility|credit facility)\b|上市|收购|並購|買収|인수|上場/i;

// Unambiguous raise wording: keeps "X raises $5M and acquires Y" even though it mentions an acquisition
const STRONG_RE = /\b(raises?|raised|series [a-h]|seed round|pre-seed|funding round)\b|融资|資金調達|투자 유치|lève|levée|recauda|levanta|capta|raccoglie|finanzierungsrunde/i;

export const isFundingHeadline = (t) => FUNDING_RE.test(t || "") && (!NOT_ROUND_RE.test(t || "") || STRONG_RE.test(t || ""));

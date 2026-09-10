// ---------------------------------------------------------------------------
// aiTells.ts - the deterministic AI-writing-tell scorer, TypeScript twin.
//
// Ported from a purchased reference pack's ai-tells.js (2026-09-10) for the
// estate's Next apps. A parallel CommonJS port lives outside this repo for
// the launchd agents, which cannot import TypeScript — the two files are the
// same spec in two runtimes and MUST change together: same detector ids,
// same weights, same thresholds, or the two disagree about the same text.
//
// What it measures, and what it does not (unchanged from the source pack):
//   - 0-100 (0 = clean) from MECHANICALLY DETECTABLE tells only: patterns a
//     regex or a word count can decide. Sixteen weighted detectors plus one
//     zero-tolerance chat-artifact check.
//   - Readability is a SEPARATE axis: a computed Flesch-Kincaid grade from
//     real word/sentence/syllable math. Never folded into the 0-100 score,
//     never estimated by a model.
//   - It does NOT judge fabrication, meaning drift, voice fit or stance —
//     that is a model reviewer's job, layered on top by a consuming app;
//     this module is the mechanical half only.
//
// Calibration contract (release-blocking, carried over from the source
// pack): genuine human writing must score clean (< ~12) and deliberate slop
// must score high (> ~45). False positives on real human voice outrank every
// other concern - every detector carries an explicit false-positive guard,
// a single word-list hit never flags, and vocabulary is only ever a cluster
// signal. `FIXTURE_CLEAN`/`FIXTURE_SLOP` are exported so `aiTells.test.ts`
// can pin this contract without duplicating the fixture text.
//
// The word lists are data tables IN this file on purpose (no external config
// in v1), same as the source pack. Dated 2026-07 (inherited); re-audit about
// every 6 months - the words age out, the method does not.
//
// Pure, dependency-free (`stripHtmlForScoring` imports the estate's own
// `htmlToText` from ./emailit, which is itself framework-free and fetch-only
// - no external packages either way).
// ---------------------------------------------------------------------------

import { htmlToText } from "./emailit";

/* ------------------------------- public types ------------------------------ */

export type AiTellsVerdict = "clean" | "pass-with-notes" | "fix";

/** Channels this pack knows a readability ceiling for. Unknown -> "article". */
export type AiTellsChannel = "email" | "sales" | "landing" | "article" | "social" | "ad";

export interface VoiceConfig {
  /** "zero" = the voice bans em dashes outright, any hit flags. Default "rate": only density flags. */
  emDash?: "rate" | "zero";
  /** Signature phrases the voice file blesses - matching hits are dropped, never scored. */
  sanctioned?: string[];
  /** Domain words removed from the AI-vocabulary cluster list (e.g. "landscape" for a gardener). */
  allowWords?: string[];
  /** "straight" = flag curly quotes (house style). Default "any": never flagged. */
  quotes?: "straight" | "any";
}

/**
 * The safe default when a caller passes no voice config at all: em dashes
 * flag on any hit rather than only on density. This module ships no
 * per-brand voice map — brand/product-specific config (which brand bans
 * which word, which phrase a voice file sanctions) is exactly the kind of
 * thing that stays in the CONSUMING app's own code (golden rule 1 in this
 * repo's CLAUDE.md: "brand-specific or product-specific logic ... stays in
 * the consuming repo's own lib/"), never in this public, framework-agnostic
 * module. A consumer builds its own `Record<string, VoiceConfig>` keyed on
 * its own brand/tenant slugs and passes the resolved `VoiceConfig` in here.
 */
export const DEFAULT_VOICE: Required<VoiceConfig> = {
  emDash: "zero",
  sanctioned: [],
  allowWords: [],
  quotes: "any",
};

export interface ScoreOptions {
  /** An inline voice override, merged onto `DEFAULT_VOICE`. Omit for the safe default. */
  voice?: VoiceConfig;
  channel?: AiTellsChannel | string;
}

export interface AiTellsDetectorResult {
  id: string;
  rule: string;
  name: string;
  weight: number;
  score: number;
  hits: string[];
  /** Only set on the zero-tolerance chat-artifacts entry. */
  hardFail?: boolean;
}

export interface AiTellsReadability {
  grade: number;
  ease: number;
  words: number;
  sentences: number;
  syllables: number;
  /** Counted separately on purpose - folding them into "sentences" is how fragments fake a low grade. */
  listItems: number;
  headings: number;
  channel: string;
  ceiling: number;
  withinBand: boolean;
}

export interface AiTellsResult {
  score: number;
  verdict: AiTellsVerdict;
  hardFail: boolean;
  detectors: AiTellsDetectorResult[];
  /** Matched chat-artifact strings (E04). Any entry here is a hard fail, separate from the 0-100 score. */
  zeroTolerance: string[];
  readability: AiTellsReadability;
  meta: {
    sentences: number;
    words: number;
    paragraphs: number;
    frontmatterStripped: boolean;
    voiceConfig: Required<VoiceConfig>;
    vocabListDate: string;
  };
}

/* ------------------------------- data tables ------------------------------ */

// AI-vocab CLUSTER list, dated 2026-07 (inherited from the source pack).
// Single hits NEVER flag. Only a cluster of >= 3 distinct entries inside a
// ~400-word window scores, and at least 2 of them must be high/mid tier (a
// legacy-only cluster never flags).
const VOCAB_HIGH = [
  "delve", "delves", "delved", "delving",
  "showcase", "showcases", "showcased", "showcasing",
  "underscore", "underscores", "underscored", "underscoring",
  "emphasize", "emphasizes", "emphasized", "emphasizing",
  "enhance", "enhances", "enhanced", "enhancing",
  "elevate", "elevates", "elevated", "elevating",
  "leverage", "leverages", "leveraged", "leveraging",
  "foster", "fosters", "fostered", "fostering",
  "garner", "garners", "garnered", "garnering",
  "highlighting",
  "meticulous", "meticulously", "intricate", "pivotal",
];
const VOCAB_MID = [
  "tapestry", "landscape", "robust", "vibrant", "seamless", "testament",
  "realm", "beacon", "myriad", "plethora", "comprehensive", "multifaceted",
  "journey",
];
const VOCAB_LEGACY = ["additionally", "boasts", "bolstered", "nestled"];

// Unearned praise adjectives (E13). Cluster-only.
const PRAISE_WORDS = [
  "seamless", "robust", "vibrant", "transformative", "game-changing",
  "game-changer", "cutting-edge", "revolutionary", "unparalleled",
  "world-class", "best-in-class", "state-of-the-art", "industry-leading",
  "ultimate", "unforgettable",
];

// Hedges and throat-clearing (E09). One hedge is human; the stack scores.
const HEDGE_RES = [
  /\bit'?s (?:important|worth) (?:to note|noting)\b/i,
  /\bit is important to (?:note|consider|remember|understand)\b/i,
  /\bit should be noted\b/i,
  /\bneedless to say\b/i,
  /\baims to\b/i,
];
const HEDGE_OPENER_RE = /^(?:honestly|look|let'?s be honest)(?::|,)\s/i;

// Announced payoff + cliche openers (E15 / E33).
const PAYOFF_RE = /\bhere(?:'?s| is) the (?:kicker|thing|catch)\b|\bthe best part\?|\bwhat nobody tells you\b/i;
const CLICHE_OPENER_RE = /^(?:whether you'?re|in today'?s|in a world|imagine a|picture this|are you ready to)\b/i;

// Wrap-up reflex (E11). Sentence-initial with a comma.
const WRAPUP_RE = /^(?:in conclusion|in summary|overall|to sum up|ultimately),\s/i;

// Conjunctive openers (E10). Sentence-initial only.
const CONJUNCTIVE_RE = /^(?:additionally|furthermore|moreover|notably|in addition),\s/i;

// Negation pivots (E07). One free use per piece; extras score.
const NEGATION_RES = [
  /\bnot (?:just|only)\b[^.!?]{0,120}?\bbut\b/i,
  /\bisn'?t\b[^.!?]{0,120}?\bit'?s\b/i,
  /\bisn'?t just\b/i,
  /\bit'?s not (?:just|only|about)\b[^.!?]{0,120}?\b(?:but|it'?s)\b/i,
  /\bis not (?:just|only|merely|about)\b[^.!?]{0,120}?\bbut\b/i,
  /\bno \w+(?:,| —| -)? just \w+/i,
  /\bnot [^.!?]{0,60}?[—–-]\s?it'?s\b/i,
];

// Vague attribution (E14). Skipped when a named source sits in the same sentence.
const ATTRIBUTION_RE =
  /\b(?:experts?|studies|research|observers?|analysts?|industry reports?|reports)\s+(?:say|says|argue|argues|show|shows|suggest|suggests|note|notes|found|find|finds|agree|agrees|indicate|indicates)\b|\bit'?s widely (?:regarded|believed|known)\b/i;
const NAMED_SOURCE_RE = /\b(?:19|20)\d{2}\b|\b[A-Z][a-z]+ (?:University|Institute|Journal|Report|Study|Survey)\b/;

// Copula avoidance (E23): fancy stand-ins for a plain "is".
const COPULA_RE = /\b(?:serves? as|stands as|functions as|represents)\b/i;

// Superficial "-ing" tails (E17).
const ING_TAIL_RE =
  /,\s+(?:highlighting|underscoring|ensuring|reflecting|showcasing|demonstrating|signaling|signalling|emphasizing|cementing|solidifying|reinforcing|marking|transforming|elevating)\b[^.!?]{0,90}$/i;

// "Quiet/quietly" as fake gravitas (E22).
const QUIET_RE =
  /\bquiet (?:confidence|power|strength|luxury|authority|ambition|force|revolution|dominance|excellence|brilliance)\b|\bquietly (?:becoming|building|growing|winning|dominating|reshaping|transforming|redefining|revolutionizing|leading|powering)\b/i;

// Chat-artifact zero-tolerance list (E04 gate). Any hit = hard fail.
const ARTIFACT_RES = [
  /as an ai language model/i,
  /as a large language model/i,
  /i'?m sorry,? but i (?:can'?t|cannot)/i,
  /as of my last (?:training|knowledge) update/i,
  /\[INSERT[^\]]*\]/,
];

// Emoji-as-bullet detection (E24) and arrow connectors (E25).
const EMOJI_BULLET_RE = /^\s*(?:[-*+]\s*)?[☀-➿⬀-⯿\u{1F000}-\u{1FAFF}]/u;
const ARROW_RE = /→|⇒|=>/;

// Readability channel ceilings (E26). "email" / "social" / "ad" are this
// port's additions (the source pack only shipped sales/landing/article) -
// email and social get the same punchy ceiling as sales/landing copy; an ad
// gets the tightest ceiling of all, because there is no room in it to earn a
// harder sentence. Grade is a ceiling; voice is a floor.
const CHANNEL_CEILINGS: Record<string, number> = {
  sales: 6,
  landing: 6,
  article: 8,
  email: 6,
  social: 6,
  ad: 5,
};

/* ------------------------------ text plumbing ----------------------------- */

function normalize(raw: string): string {
  let t = String(raw);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface Line {
  n: number;
  text: string;
  kind: "blank" | "rule" | "heading" | "quote" | "list" | "prose";
}

interface Paragraph {
  startLine: number;
  parts: Line[];
  text: string;
  lineAt: (offset: number) => number;
  words: number;
}

interface Sentence {
  text: string;
  wordCount: number;
  line: number;
  paragraph: Paragraph;
}

interface Word {
  word: string;
  line: number;
}

interface Context {
  lines: Line[];
  paragraphs: Paragraph[];
  sentences: Sentence[];
  proseAndList: Line[];
  headings: Line[];
  listItems: Line[];
  words: Word[];
  fmStripped: boolean;
}

function prepare(text: string): Context {
  const rawLines = normalize(text).split("\n");
  const lines: Line[] = [];
  let fmStripped = false;
  let inFence = false;
  let i = 0;

  if (rawLines[0] !== undefined && /^---\s*$/.test(rawLines[0])) {
    let close = -1;
    for (let j = 1; j < rawLines.length; j++) {
      if (/^---\s*$/.test(rawLines[j]!)) { close = j; break; }
    }
    if (close !== -1) { i = close + 1; fmStripped = true; }
  }

  for (; i < rawLines.length; i++) {
    const n = i + 1;
    let t = rawLines[i]!;
    if (/^\s*```/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    t = t.replace(/\[(?:PLACEHOLDER|FILL IN)[^\]]*\]/gi, "placeholder");
    let kind: Line["kind"];
    if (t.trim() === "") kind = "blank";
    else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t)) kind = "rule";
    else if (/^#{1,6}\s/.test(t)) kind = "heading";
    else if (/^\s*>/.test(t)) kind = "quote";
    else if (/^\s*(?:[-*+]|\d+[.)])\s/.test(t)) kind = "list";
    else kind = "prose";
    lines.push({ n, text: t, kind });
  }

  const paragraphs: Paragraph[] = [];
  let cur: { startLine: number; parts: Line[] } | null = null;
  for (const ln of lines) {
    if (ln.kind === "prose") {
      if (!cur) cur = { startLine: ln.n, parts: [] };
      cur.parts.push(ln);
    } else if (ln.kind !== "blank" || !cur) {
      if (cur) { paragraphs.push(cur as Paragraph); cur = null; }
    } else {
      paragraphs.push(cur as Paragraph);
      cur = null;
    }
  }
  if (cur) paragraphs.push(cur as Paragraph);

  for (const p of paragraphs) {
    let text2 = "";
    const map: Array<{ start: number; line: number }> = [];
    for (const part of p.parts) {
      if (text2 !== "") text2 += " ";
      map.push({ start: text2.length, line: part.n });
      text2 += part.text.trim();
    }
    p.text = text2;
    p.lineAt = (offset: number) => {
      let line = p.startLine;
      for (const m of map) { if (offset >= m.start) line = m.line; else break; }
      return line;
    };
    p.words = countWords(text2);
  }

  const sentences: Sentence[] = [];
  for (const p of paragraphs) {
    for (const s of splitSentences(p.text)) {
      sentences.push({ text: s.text, wordCount: countWords(s.text), line: p.lineAt(s.start), paragraph: p });
    }
  }

  const proseAndList = lines.filter((l) => l.kind === "prose" || l.kind === "list");
  const headings = lines.filter((l) => l.kind === "heading");
  const listItems = lines.filter((l) => l.kind === "list");
  const words: Word[] = [];
  for (const l of proseAndList) {
    for (const w of l.text.split(/\s+/)) {
      const clean = w.replace(/^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g, "");
      if (clean) words.push({ word: clean.toLowerCase(), line: l.n });
    }
  }

  return { lines, paragraphs, sentences, proseAndList, headings, listItems, words, fmStripped };
}

const ABBREV_RE = /\b(?:e\.g|i\.e|vs|etc|mr|mrs|ms|dr|st|no|inc|ltd|co|jr|sr|approx|dept|est|fig|min|max|cf|al|p|pp)\.$/i;

function splitSentences(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) continue;
    if (ch === "." && ABBREV_RE.test(text.slice(Math.max(0, i - 8), i + 1))) continue;
    let j = i;
    while (j + 1 < text.length && /[.!?"')”’]/.test(text[j + 1]!)) j++;
    const next = text[j + 1];
    if (next !== undefined && next !== " ") { i = j; continue; }
    const piece = text.slice(start, j + 1).trim();
    if (piece) out.push({ text: piece, start });
    start = j + 2;
    i = j + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ text: tail, start });
  return out;
}

function countWords(text: string): number {
  const m = String(text).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  return m.length;
}

/** Syllable heuristic: vowel groups, silent e, floor of 1. Real math (E26). */
export function countSyllables(word: string): number {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  let s = w.replace(/e$/, "");
  if (/le$/.test(w) && !/[aeiouy]le$/.test(w)) s = w;
  const groups = s.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) * (x - m))));
}

function normPhrase(s: string): string {
  return String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function isSanctioned(matched: string, cfg: Required<VoiceConfig>): boolean {
  if (!cfg.sanctioned || cfg.sanctioned.length === 0) return false;
  const m = normPhrase(matched);
  return cfg.sanctioned.some((p) => {
    const q = normPhrase(p);
    return q !== "" && (m.indexOf(q) !== -1 || q.indexOf(m) !== -1);
  });
}

/** The minimal shape the phrase detectors need — a real sentence or a list item standing in for one. */
interface SentenceLike { text: string; line: number; wordCount: number }

/** List items rendered as pseudo-sentences for the phrase detectors. */
function listAsSentences(ctx: Context): SentenceLike[] {
  return ctx.listItems.map((l) => ({
    text: l.text.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, ""),
    line: l.n,
    wordCount: 0,
  }));
}

/** Real sentences plus list items, for detectors that only read `.text`/`.line`. */
function sentencesAndListItems(ctx: Context): SentenceLike[] {
  return (ctx.sentences as SentenceLike[]).concat(listAsSentences(ctx));
}

/* -------------------------------- detectors ------------------------------- */

interface DetectorHit { line: number; text: string }
interface DetectorOutcome { hits: DetectorHit[]; score: number }
interface Detector {
  id: string;
  rule: string;
  weight: number;
  name: string;
  detect: (ctx: Context, cfg: Required<VoiceConfig>) => DetectorOutcome;
}

const DETECTORS: Detector[] = [
  {
    id: "burstiness", rule: "E06", weight: 20,
    name: "Sentence rhythm is machine-even",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const lens = ctx.sentences.map((s) => s.wordCount);
      if (lens.length < 5) return { hits, score };
      for (let i = 0; i + 2 < lens.length; i++) {
        const win = lens.slice(i, i + 3);
        if (Math.min(...win) >= 12 && Math.max(...win) - Math.min(...win) <= 2) {
          hits.push({ line: ctx.sentences[i]!.line, text: "three sentences in a row of " + win.join(", ") + " words" });
          score += 8;
          break;
        }
      }
      const inBand = lens.filter((l) => l >= 15 && l <= 28).length;
      if (inBand / lens.length >= 0.85) {
        hits.push({ line: ctx.sentences[0]!.line, text: Math.round((inBand / lens.length) * 100) + "% of sentences sit in the 15-28 word band" });
        score += 8;
      }
      const sd = stdev(lens);
      if (sd < 6 && mean(lens) >= 15) {
        hits.push({ line: ctx.sentences[0]!.line, text: "sentence lengths barely vary (spread " + sd.toFixed(1) + ")" });
        score += 8;
      }
      const plens = ctx.paragraphs.map((p) => p.words).filter((w) => w > 0);
      if (plens.length >= 4) {
        const cv = mean(plens) > 0 ? stdev(plens) / mean(plens) : 1;
        if (cv < 0.2) {
          hits.push({ line: ctx.paragraphs[0]!.startLine, text: "every paragraph is nearly the same length" });
          score += 4;
        }
      }
      return { hits, score: Math.min(score, 20) };
    },
  },
  {
    id: "vocab-cluster", rule: "E05", weight: 15,
    name: "AI-vocabulary cluster (dated list, 2026-07)",
    detect(ctx, cfg) {
      const allow = new Set((cfg.allowWords || []).map((w) => String(w).toLowerCase()));
      const tier = new Map<string, "high" | "mid" | "legacy">();
      for (const w of VOCAB_HIGH) tier.set(w, "high");
      for (const w of VOCAB_MID) tier.set(w, "mid");
      for (const w of VOCAB_LEGACY) tier.set(w, "legacy");
      const found: Array<{ idx: number; word: string; line: number; tier: string }> = [];
      ctx.words.forEach((w, idx) => {
        if (tier.has(w.word) && !allow.has(w.word)) {
          found.push({ idx, word: w.word, line: w.line, tier: tier.get(w.word)! });
        }
      });
      ctx.proseAndList.forEach((l) => {
        if (/in today'?s fast-paced world/i.test(l.text)) {
          found.push({ idx: 0, word: "in today's fast-paced world", line: l.n, tier: "legacy" });
        }
      });
      let best: Array<{ idx: number; word: string; line: number; tier: string }> | null = null;
      for (let a = 0; a < found.length; a++) {
        const windowEnd = found[a]!.idx + 400;
        const distinct = new Map<string, { idx: number; word: string; line: number; tier: string }>();
        for (let b = a; b < found.length; b++) {
          if (found[b]!.idx > windowEnd) break;
          if (!distinct.has(found[b]!.word)) distinct.set(found[b]!.word, found[b]!);
        }
        const entries = [...distinct.values()];
        const nonLegacy = entries.filter((e) => e.tier !== "legacy").length;
        if (entries.length >= 3 && nonLegacy >= 2) {
          if (!best || entries.length > best.length) best = entries;
        }
      }
      if (!best) return { hits: [], score: 0 };
      const hits = best.map((e) => ({ line: e.line, text: e.word }));
      const score = Math.min(15, Math.round(8 + 2.5 * (best.length - 3)));
      return { hits, score };
    },
  },
  {
    id: "formatting", rule: "E24", weight: 8,
    name: "Formatting overuse (bold, Title Case, emoji bullets)",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const totalWords = ctx.words.length;
      let boldCount = 0;
      let firstBoldLine = 0;
      let wholeSentenceBold = 0;
      for (const l of ctx.proseAndList) {
        const spans = l.text.match(/\*\*[^*]+\*\*/g) || [];
        if (spans.length && !firstBoldLine) firstBoldLine = l.n;
        boldCount += spans.length;
        for (const s of spans) {
          if (countWords(s.replace(/\*\*/g, "")) >= 8) {
            wholeSentenceBold++;
            hits.push({ line: l.n, text: "a whole sentence in bold" });
          }
        }
      }
      if (boldCount >= 2 && totalWords > 0 && boldCount > totalWords / 80) {
        hits.push({ line: firstBoldLine, text: boldCount + " bolded phrases in " + totalWords + " words" });
        score += 3;
      }
      const boldListLabels = ctx.listItems.filter((l) => /^\s*(?:[-*+]\s*)?\*\*[^*]+\*\*/.test(l.text));
      if (boldListLabels.length >= 3 && score === 0) {
        hits.push({ line: boldListLabels[0]!.n, text: boldListLabels.length + " list items begin with bold labels" });
        score += 3;
      }
      score += Math.min(4, wholeSentenceBold * 2);
      for (const h of ctx.headings) {
        const text = h.text.replace(/^#{1,6}\s+/, "");
        const wordsIn = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
        const minor = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "at", "by", "is", "your", "our"]);
        const significant = wordsIn.filter((w) => !minor.has(w.toLowerCase()));
        const capped = significant.filter((w) => /^[A-Z]/.test(w));
        if (significant.length >= 3 && capped.length / significant.length >= 0.75) {
          hits.push({ line: h.n, text: text.slice(0, 60) });
          score += 2;
        }
      }
      for (const l of ctx.lines) {
        if ((l.kind === "list" || l.kind === "prose") && EMOJI_BULLET_RE.test(l.text)) {
          hits.push({ line: l.n, text: l.text.trim().slice(0, 40) });
          score += 2;
        }
      }
      return { hits, score: Math.min(score, 8) };
    },
  },
  {
    id: "negation-pivot", rule: "E07", weight: 8,
    name: "Negation pivot (\"not X, it's Y\")",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const s of ctx.sentences) {
        for (const re of NEGATION_RES) {
          const m = re.exec(s.text);
          if (m) { hits.push({ line: s.line, text: m[0].slice(0, 80) }); break; }
        }
      }
      const score = Math.min(8, Math.max(0, hits.length - 1) * 4);
      return { hits, score };
    },
  },
  {
    id: "vague-attribution", rule: "E14", weight: 6,
    name: "Vague attribution (\"experts say\", \"studies show\")",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const s of sentencesAndListItems(ctx)) {
        const m = ATTRIBUTION_RE.exec(s.text);
        if (!m) continue;
        if (NAMED_SOURCE_RE.test(s.text)) continue;
        hits.push({ line: s.line, text: m[0] });
      }
      return { hits, score: Math.min(6, hits.length * 3) };
    },
  },
  {
    id: "hedge-stack", rule: "E09", weight: 6,
    name: "Hedges and throat-clearing",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const s of sentencesAndListItems(ctx)) {
        for (const re of HEDGE_RES) {
          const m = re.exec(s.text);
          if (m) { hits.push({ line: s.line, text: m[0] }); break; }
        }
        const o = HEDGE_OPENER_RE.exec(s.text);
        if (o) hits.push({ line: s.line, text: o[0].trim() });
      }
      const score = hits.length >= 2 ? Math.min(6, (hits.length - 1) * 3) : 0;
      return { hits, score };
    },
  },
  {
    id: "praise-adjectives", rule: "E13", weight: 6,
    name: "Unearned praise adjectives",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      const re = new RegExp("\\b(?:" + PRAISE_WORDS.join("|") + ")\\b", "gi");
      for (const l of ctx.proseAndList) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(l.text))) hits.push({ line: l.n, text: m[0] });
      }
      const score = hits.length >= 2 ? Math.min(6, hits.length * 2) : 0;
      return { hits, score };
    },
  },
  {
    id: "em-dash-rate", rule: "E12", weight: 6,
    name: "Em-dash rate (or any hit when the voice bans them)",
    detect(ctx, cfg) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const counts: number[] = [];
      for (const p of ctx.paragraphs) {
        const m = p.text.match(/—|\s--\s/g) || [];
        counts.push(m.length);
        if (cfg.emDash === "zero") {
          if (m.length > 0) {
            hits.push({ line: p.startLine, text: m.length + " em dash(es) - the voice file bans them" });
            score += m.length * 3;
          }
        } else if (m.length >= 3) {
          hits.push({ line: p.startLine, text: m.length + " em dashes in one paragraph" });
          score += 3;
        }
      }
      if (cfg.emDash !== "zero") {
        const total = counts.reduce((a, b) => a + b, 0);
        if (counts.length > 0 && total >= 3 && total / counts.length > 1) {
          hits.push({ line: ctx.paragraphs[0] ? ctx.paragraphs[0].startLine : 1, text: total + " em dashes across " + counts.length + " paragraph(s)" });
          score += 3;
        }
      }
      return { hits, score: Math.min(score, 6) };
    },
  },
  {
    id: "conjunctive-openers", rule: "E10", weight: 5,
    name: "Empty transition openers (Additionally, Furthermore, ...)",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const s of sentencesAndListItems(ctx)) {
        const m = CONJUNCTIVE_RE.exec(s.text);
        if (m) hits.push({ line: s.line, text: m[0].trim() });
      }
      const score = hits.length === 0 ? 0 : Math.min(5, 3 + (hits.length - 1) * 2);
      return { hits, score };
    },
  },
  {
    id: "wrap-up", rule: "E11", weight: 5,
    name: "Wrap-up reflex (In conclusion, In summary, ...)",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const n = ctx.sentences.length;
      ctx.sentences.forEach((s, i) => {
        const m = WRAPUP_RE.exec(s.text);
        if (!m) return;
        const late = n > 0 && i >= Math.floor(n * 0.8);
        hits.push({ line: s.line, text: m[0].trim() + (late ? " (closing the piece)" : "") });
        score += late ? 5 : 3;
      });
      return { hits, score: Math.min(score, 5) };
    },
  },
  {
    id: "announced-payoff", rule: "E15/E33", weight: 5,
    name: "Announced payoffs and cliche openers",
    detect(ctx, cfg) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const openingSentences = ctx.paragraphs.slice(0, 3)
        .map((p) => ctx.sentences.find((s) => s.paragraph === p))
        .filter((s): s is Sentence => Boolean(s));
      for (const first of openingSentences) {
        const m = CLICHE_OPENER_RE.exec(first.text);
        if (m && !isSanctioned(m[0], cfg)) {
          hits.push({ line: first.line, text: m[0] + "... (stock opener)" });
          score += 3;
        }
      }
      for (const s of sentencesAndListItems(ctx)) {
        const m = PAYOFF_RE.exec(s.text);
        if (m && !isSanctioned(m[0], cfg)) {
          hits.push({ line: s.line, text: m[0] });
          score += 2;
        }
      }
      return { hits, score: Math.min(score, 5) };
    },
  },
  {
    id: "punctuation-tics", rule: "E25", weight: 4,
    name: "Punctuation and unicode tics",
    detect(ctx, cfg) {
      const hits: DetectorHit[] = [];
      let score = 0;
      for (const l of ctx.proseAndList) {
        const arrow = ARROW_RE.exec(l.text);
        if (arrow) { hits.push({ line: l.n, text: "arrow used as a connector (" + arrow[0] + ")" }); score += 2; }
        const emph = /(^|\s)["“]([A-Za-z-]+)["”](?=[\s.,;:!?]|$)/.exec(l.text);
        if (emph) { hits.push({ line: l.n, text: 'scare quotes around "' + emph[2] + '"' }); score += 1; }
        if (cfg.quotes === "straight" && /[“”‘’]/.test(l.text)) {
          hits.push({ line: l.n, text: "curly quotes (house style is straight)" });
          score += 1;
        }
      }
      for (const p of ctx.paragraphs) {
        const bangs = (p.text.match(/!/g) || []).length;
        if (bangs >= 2) { hits.push({ line: p.startLine, text: bangs + " exclamation marks in one paragraph" }); score += 2; }
      }
      return { hits, score: Math.min(score, 4) };
    },
  },
  {
    id: "ing-tail", rule: "E17", weight: 4,
    name: 'Superficial "-ing" tails (…, highlighting its importance)',
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const s of sentencesAndListItems(ctx)) {
        const body = s.text.replace(/[.!?]+$/, "");
        const m = ING_TAIL_RE.exec(body);
        if (m) hits.push({ line: s.line, text: m[0].slice(0, 70) });
      }
      return { hits, score: Math.min(4, hits.length * 2) };
    },
  },
  {
    id: "copula-avoidance", rule: "E23", weight: 3,
    name: "Copula avoidance (serves as, stands as, represents)",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const l of ctx.proseAndList) {
        let m: RegExpExecArray | null;
        const re = new RegExp(COPULA_RE.source, "gi");
        while ((m = re.exec(l.text))) hits.push({ line: l.n, text: m[0] });
      }
      const score = hits.length === 0 ? 0 : hits.length === 1 ? 2 : 3;
      return { hits, score };
    },
  },
  {
    id: "quiet-gravitas", rule: "E22", weight: 3,
    name: '"Quiet/quietly" as fake gravitas',
    detect(ctx) {
      const hits: DetectorHit[] = [];
      for (const l of ctx.proseAndList) {
        let m: RegExpExecArray | null;
        const re = new RegExp(QUIET_RE.source, "gi");
        while ((m = re.exec(l.text))) hits.push({ line: l.n, text: m[0] });
      }
      const total = ctx.words.length;
      const flag = hits.length >= 2 || (hits.length === 1 && total < 150);
      return { hits, score: flag ? 3 : 0 };
    },
  },
  {
    id: "rule-of-three", rule: "E08", weight: 5,
    name: "Rule-of-three stacks and anaphora",
    detect(ctx) {
      const hits: DetectorHit[] = [];
      let score = 0;
      const triples: DetectorHit[] = [];
      const re = /\b(\w+(?:\s\w+)?), (\w+(?:\s\w+)?),? and (\w+(?:\s\w+)?)\b/g;
      for (const l of ctx.proseAndList) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(l.text))) triples.push({ line: l.n, text: m[0] });
      }
      if (triples.length > 2) {
        for (const t of triples.slice(2)) hits.push(t);
        score += (triples.length - 2) * 2;
      }
      const firsts = ctx.sentences.map((s) => {
        let opening = s.text;
        const colon = opening.indexOf(":");
        if (colon !== -1 && countWords(opening.slice(0, colon)) <= 4) opening = opening.slice(colon + 1).trim();
        return (opening.split(/\s+/)[0] || "").toLowerCase().replace(/[^a-z']/g, "");
      });
      for (let i = 0; i + 2 < firsts.length; i++) {
        if (firsts[i] && firsts[i] === firsts[i + 1] && firsts[i] === firsts[i + 2]) {
          hits.push({ line: ctx.sentences[i]!.line, text: 'three sentences in a row open with "' + firsts[i] + '"' });
          score += 3;
          break;
        }
      }
      for (let i = 0; i + 2 < ctx.sentences.length; i++) {
        const trio = ctx.sentences.slice(i, i + 3);
        if (trio.every((s) => s.wordCount >= 1 && s.wordCount <= 3)) {
          hits.push({ line: trio[0]!.line, text: "three clipped beats in a row" });
          score += 5;
          break;
        }
      }
      return { hits, score: Math.min(score, 5) };
    },
  },
];

/** Detector #17: chat artifacts. Zero tolerance - any hit is a hard fail. */
function detectArtifacts(ctx: Context): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const l of ctx.lines) {
    for (const re of ARTIFACT_RES) {
      const m = re.exec(l.text);
      if (m) hits.push({ line: l.n, text: m[0] });
    }
  }
  return hits;
}

/** Detector #18: computed readability - the separate axis (E26). */
function computeReadability(ctx: Context, channel: string | undefined): AiTellsReadability {
  const sentences = ctx.sentences.filter((s) => s.wordCount > 0);
  let words = 0;
  let syllables = 0;
  for (const s of sentences) {
    for (const w of s.text.split(/\s+/)) {
      if (!/[A-Za-z]/.test(w)) continue;
      words++;
      syllables += countSyllables(w);
    }
  }
  const n = sentences.length;
  const grade = n > 0 && words > 0 ? 0.39 * (words / n) + 11.8 * (syllables / words) - 15.59 : 0;
  const ease = n > 0 && words > 0 ? 206.835 - 1.015 * (words / n) - 84.6 * (syllables / words) : 0;
  const ceiling = (channel && CHANNEL_CEILINGS[channel]) || CHANNEL_CEILINGS.article!;
  return {
    grade: Math.round(grade * 10) / 10,
    ease: Math.round(ease * 10) / 10,
    words,
    sentences: n,
    syllables,
    listItems: ctx.listItems.length,
    headings: ctx.headings.length,
    channel: channel && CHANNEL_CEILINGS[channel] ? channel : "article",
    ceiling,
    withinBand: n === 0 ? true : grade <= ceiling + 0.5,
  };
}

function resolveVoiceConfig(voice: VoiceConfig | undefined): Required<VoiceConfig> {
  return { ...DEFAULT_VOICE, ...(voice ?? {}) };
}

function verdictFor(score: number, hardFail: boolean): AiTellsVerdict {
  if (hardFail) return "fix";
  if (score > 45) return "fix";
  if (score >= 12) return "pass-with-notes";
  return "clean";
}

/**
 * scoreText(text, opts) -> the full report.
 *
 * `opts.voice` is an inline `VoiceConfig`, merged onto `DEFAULT_VOICE` — a
 * consumer that keeps its own per-brand/tenant voice map resolves that
 * lookup itself and passes the resulting config in here. `opts.channel`
 * picks the readability ceiling. Both are optional - the defaults (zero em
 * dashes, "article" ceiling) are safe for any caller that has not decided
 * its voice/channel yet.
 */
export function scoreText(text: string, opts?: ScoreOptions): AiTellsResult {
  const cfg = resolveVoiceConfig(opts?.voice);
  const ctx = prepare(text);

  const detectors: AiTellsDetectorResult[] = [];
  let total = 0;
  for (const d of DETECTORS) {
    const r = d.detect(ctx, cfg);
    detectors.push({ id: d.id, rule: d.rule, name: d.name, weight: d.weight, score: r.score, hits: r.hits.map((h) => h.text) });
    total += r.score;
  }
  const artifactHits = detectArtifacts(ctx);
  const hardFail = artifactHits.length > 0;
  detectors.push({
    id: "chat-artifacts", rule: "E04", name: "Chat artifacts (zero tolerance)",
    weight: 0, score: 0, hits: artifactHits.map((h) => h.text), hardFail,
  });

  const readability = computeReadability(ctx, opts?.channel);
  const score = Math.min(100, Math.round(total));

  return {
    score,
    verdict: verdictFor(score, hardFail),
    hardFail,
    detectors,
    zeroTolerance: artifactHits.map((h) => h.text),
    readability,
    meta: {
      sentences: ctx.sentences.length,
      words: ctx.words.length,
      paragraphs: ctx.paragraphs.length,
      frontmatterStripped: ctx.fmStripped,
      voiceConfig: cfg,
      vocabListDate: "2026-07",
    },
  };
}

/**
 * Turns an email's HTML body into scorable prose. Delegates to the estate's
 * own `htmlToText` (./emailit.ts) rather than a naive tag-strip: that
 * function already turns block tags into blank-line paragraph breaks (which
 * `scoreText`'s `prepare()` needs to find sentences and paragraphs), unwraps
 * links as "text (url)" so a CTA's destination does not vanish, and decodes
 * every entity the estate's templates actually emit - a naive
 * `replace(/<[^>]+>/g, "")` collapses paragraph structure entirely, which
 * would make the burstiness/rhythm detectors (E06) meaningless on HTML
 * email, the exact failure this helper exists to avoid.
 */
export function stripHtmlForScoring(html: string): string {
  return htmlToText(html);
}

/* ------------------------------- self-test -------------------------------- */
/* Same fixtures as the source pack (constructed fresh, never copied from any */
/* real business). Exported so aiTells.test.ts can assert the calibration     */
/* contract without duplicating the fixture text.                            */

export const FIXTURE_CLEAN = [
  "Last March our oven died on a Friday.",
  "Not a great day.",
  "We had sixty orders due and one very old backup plan: my mother's kitchen across town.",
  "So that is where the bread got baked, four loaves at a time, until two in the morning.",
  "I bring this up because three people asked me this week why we do not just open a second shop.",
  "Honest answer?",
  "We tried something close to it once, back in 2019, and it nearly sank us.",
  "The second shop looked busy and lost money for eleven straight months.",
  "What works for us is boring: one shop, a short menu, bread that sells out by noon.",
  "If you came by after lunch and left empty-handed, sorry about that.",
  "Come at nine.",
  "The sourdough is worth the alarm clock.",
].join("\n");

export const FIXTURE_SLOP = [
  "# Unlock Your Business Potential With Our Comprehensive Platform",
  "",
  "Whether you're a small business owner or a seasoned marketing professional, our robust platform serves as a comprehensive solution for all your evolving needs. It's worth noting that our seamless onboarding experience represents a pivotal milestone in every customer journey today. Additionally, our vibrant community stands as a testament to the transformative power of these cutting-edge tools. Furthermore, experts say that businesses that leverage intelligent automation delve far deeper into meaningful growth. It's important to note that the platform showcases measurable outcomes, highlighting its importance for modern teams.",
  "",
  "Here's the kicker: this isn't just a tool — it's a movement — and honestly, a complete transformation! It's not just software but a true partner. The quiet confidence of our approach means we are quietly transforming an entire industry — for good! Our platform offers **streamlined workflows**, **enhanced productivity**, and **seamless integration**.",
  "",
  "- ✅ Faster onboarding → more revenue!",
  "- \u{1F680} Studies show that automation saves teams hours every week!",
  "",
  "We deliver innovation, inspiration, and insights. We provide speed, scale, and simplicity. We ensure growth, guidance, and grit. As an AI language model, I can confirm the results, ensuring success for your business. [INSERT customer testimonial]",
  "",
  "In conclusion, our meticulous approach underscores our commitment to unparalleled excellence, reflecting the values of a truly world-class team.",
].join("\n");

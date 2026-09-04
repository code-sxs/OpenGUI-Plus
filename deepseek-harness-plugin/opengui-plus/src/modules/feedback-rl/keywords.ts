/**
 * Dependency-free keyword retrieval for the feedback experience store.
 *
 * There is no embedding model and no tokenizer package available inside the
 * plugin, so relevance is computed with a lexical overlap score instead:
 *
 *   score(query, doc) = |tokens(query) ∩ tokens(doc)| / |tokens(query)|
 *
 * Chinese is segmented by character bigram (`登录失败` → 登录, 录失, 失败)
 * because bigrams recover most of the word boundaries a real segmenter would
 * find, without shipping a dictionary. Latin text is split on whitespace and
 * punctuation and lowercased. The two are mixed in one bag of tokens, which is
 * what a bilingual symptom such as "ANR 弹窗" needs.
 *
 * The scorer is deliberately normalised by the *query* length, not by the union:
 * a long experience entry that happens to mention the query words is a good
 * match, while a long query against a short entry should still be able to score
 * 1.0.
 *
 * @module modules/feedback-rl/keywords
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WORD = /[A-Za-z0-9_]/
/** Latin tokens shorter than this carry no signal ("a", "3"). */
const MIN_LATIN_LENGTH = 2

/**
 * Split text into comparable tokens: Han bigrams plus lowercased latin words.
 * Duplicate tokens are collapsed so a repeated phrase cannot outvote the rest.
 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>()
  let han = ''
  let latin = ''

  const flushHan = (): void => {
    if (han.length === 0) return
    if (han.length === 1) {
      seen.add(han)
    }
    else {
      for (let index = 0; index + 2 <= han.length; index += 1) {
        seen.add(han.slice(index, index + 2))
      }
    }
    han = ''
  }

  const flushLatin = (): void => {
    if (latin.length >= MIN_LATIN_LENGTH) seen.add(latin.toLowerCase())
    latin = ''
  }

  for (const char of text) {
    if (HAN.test(char)) {
      flushLatin()
      han += char
      continue
    }
    if (WORD.test(char)) {
      flushHan()
      latin += char
      continue
    }
    flushHan()
    flushLatin()
  }
  flushHan()
  flushLatin()
  return [...seen]
}

/** Overlap ratio of the query tokens inside the document tokens. */
export function overlapScore(query: readonly string[], document: readonly string[]): number {
  if (query.length === 0) return 0
  const pool = new Set(document)
  let matched = 0
  for (const token of query) {
    if (pool.has(token)) matched += 1
  }
  return matched / query.length
}

export interface ScoredItem<T> {
  readonly item: T
  readonly score: number
}

/**
 * Rank documents against a query, best first.
 * Zero-score documents are dropped, and ties are broken by `tieBreak`
 * (callers pass hit count) so a popular experience wins over an obscure one.
 */
export function rank<T>(
  query: readonly string[],
  documents: readonly T[],
  toText: (item: T) => string,
  tieBreak: (item: T) => number,
): ScoredItem<T>[] {
  const scored: ScoredItem<T>[] = []
  for (const item of documents) {
    const score = overlapScore(query, tokenize(toText(item)))
    if (score <= 0) continue
    scored.push({ item, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (tieBreak(b.item) - tieBreak(a.item)))
  return scored
}

/** Round to two decimals so scores stay stable in JSON snapshots. */
export function roundScore(score: number): number {
  return Math.round(score * 100) / 100
}

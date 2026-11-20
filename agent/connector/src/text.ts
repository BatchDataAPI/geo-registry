// Tokenizer shared by the index builder (Node) and the Worker, so both split
// text the same way.

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "get",
  "how", "i", "in", "into", "is", "it", "me", "my", "need", "of", "on", "or", "the", "to",
  "use", "want", "what", "which", "with",
]);

/** Lowercase, strip accents, split on anything not a letter or digit, drop stop words, fold plurals. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  const norm = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const raw of norm.split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    out.push(fold(raw));
  }
  return out;
}

/** Light plural folding: "buffers" -> "buffer", "classes" -> "class", "counties" -> "county". */
export function fold(t: string): string {
  if (t.length <= 3 || /\d/.test(t)) return t;
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith("sses") || t.endsWith("xes") || t.endsWith("ches") || t.endsWith("shes")) return t.slice(0, -2);
  if (t.endsWith("ss") || t.endsWith("us") || t.endsWith("is")) return t;
  if (t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Plain words for place matching (no stop words removed, no folding). */
export function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

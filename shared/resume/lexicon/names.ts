/**
 * Word lists for name redaction (Novus's own). A student's first name is redacted on its own
 * only when it is not also an everyday word, month, place or company: redacting "May",
 * "Grant", "Hope" or "Summer" everywhere would destroy dates and phrases like "Pell Grant"
 * or "May 2025". The full name, "F. Last" and "Last, First" are always redacted.
 */

/** First names that are also words. Lowercase, diacritics folded. */
export const STOP_FIRST_NAMES: ReadonlySet<string> = new Set([
  "may", "june", "april", "august", "summer", "autumn", "winter", "spring", "grant", "hope", "faith", "joy",
  "grace", "rose", "lily", "ivy", "iris", "daisy", "violet", "jade", "ruby", "pearl", "amber", "crystal", "sky",
  "river", "rain", "dawn", "eve", "will", "mark", "bill", "pat", "art", "don", "sue", "ray", "max", "gene",
  "dean", "chase", "wade", "hunter", "mason", "cole", "drew", "lane", "page", "price", "rich", "jack", "penny",
  "sage", "angel", "sunny", "star", "storm", "honor", "justice", "liberty", "harmony", "melody", "destiny",
  "trinity", "chance", "miles", "carol", "sandy", "rocky", "rusty", "ginger", "holly", "heather", "olive",
  "hazel", "willow", "aspen", "reed", "rowan", "robin", "wren", "jay", "cliff", "glen", "dale", "forest",
  "ford", "cash", "king", "prince", "duke", "earl", "major", "sterling", "jasper", "opal", "coral", "marina",
  "brook", "frank", "earnest", "constance", "charity", "mercy", "patience", "noble", "royal", "ada", "pascal",
  "julia", "austin", "dallas", "houston", "paris", "london", "georgia", "virginia", "carolina", "dakota",
  "jordan", "sydney", "victoria", "madison", "brooklyn", "phoenix", "florence", "savannah", "chelsea",
  "lincoln", "washington", "jackson", "kent", "morgan", "stanley", "wells", "dell", "gates", "rob", "bob",
  "kim", "sam", "al", "ed", "ted", "tim", "tom", "joe", "lee", "van", "ali", "ian", "amy", "ana", "eli",
  "asia", "china", "india", "kenya", "israel", "egypt", "nile", "york", "cruz", "santa", "lucky", "happy",
  "bliss", "unity", "serenity", "precious", "genesis", "nova", "luna", "sol", "terra", "echo", "blaze",
  "ace", "beau", "bear", "colt", "fox", "hawk", "leo", "orion", "rex", "sonny", "tiger", "zion",
]);

/** Surnames that are also words; redacted only when capitalized, so "brown rice" survives. */
export const COMMON_WORD_SURNAMES: ReadonlySet<string> = new Set([
  "brown", "black", "white", "green", "gray", "grey", "young", "king", "hall", "wood", "woods", "hill", "rose",
  "bell", "long", "little", "hunter", "price", "lane", "cook", "baker", "carpenter", "fisher", "miller",
  "mason", "walker", "turner", "parker", "love", "may", "hope", "grant", "banks", "rich", "strong", "day",
  "field", "fields", "stone", "rivers", "brooks", "lake", "snow", "frost", "fox", "wolf", "bird", "swan",
  "crane", "west", "north", "south", "east", "english", "french", "holland", "wells", "bush", "ford",
  "gates", "waters", "major", "marshall", "sharp", "short", "small", "smart", "hardy", "rice", "best",
  "noble", "page", "golden", "gold", "silver", "summers", "winter", "spring", "march", "street", "church",
  "chase", "cross", "park", "parks", "ball", "bond", "booth", "bowman", "dean", "duke", "earl", "hart",
  "head", "high", "house", "jordan", "knight", "lord", "mann", "moon", "nash", "pope", "power", "reed",
  "rock", "rush", "salt", "sweet", "true", "ward", "wise", "drew", "case", "cash", "story", "sterling",
  "law", "lee", "song", "do", "ha", "ho", "ma", "an", "so", "to", "go", "sun", "young",
]);

/** Honorifics and suffixes dropped from a seed before building patterns. */
export const NAME_NOISE: ReadonlySet<string> = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"]);

/** Strings that are not names even when they arrive as a PDF author. */
export const NOT_A_NAME = /^(?:microsoft\s+office\s+user|office\s+user|user|admin(?:istrator)?|owner|author|unknown|canva|google\s+docs|resume|cv|curriculum\s+vitae|word|pages|windows\s+user|apple)$/i;

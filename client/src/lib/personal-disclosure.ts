/**
 * Browser-side guard for free-text questions sent to the AI routes (Ask Novus, the readiness
 * assistant). A question that discloses a sensitive status about the asker ("I'm Black", "my
 * parents never went to college") would carry a SensitiveAnswer to a server route, so the screen
 * stops it before anything is sent. The server redacts as well; this is the first layer.
 *
 * The check looks for the student describing themselves, not for topic words alone: "Does the
 * program require citizenship?" and "Can I start my essay on race?" are ordinary questions and go
 * through. Each sentence is checked on its own, so "I'm a sophomore. Is citizenship required?"
 * is fine too.
 */

interface PersonalTopic {
  readonly topic: string;
  /** Topic words, as a regex source without anchors or flags. */
  readonly words: string;
  /** Things a student holds or is on ("a student visa", "Pell"), for "can I apply on/with ..." questions. */
  readonly held?: string;
}

const PERSONAL_TOPICS: readonly PersonalTopic[] = [
  {
    topic: "citizenship or immigration status",
    words:
      "citizen(?:ship)?|green ?card|permanent resident|daca|dreamer|undocumented|tps|(?:student )?visa|f-?1|j-?1|h-?1b|immigra\\w*|asylum|asylee|refugee|international student|non-?citizen",
    held: "(?:student )?visa|green ?card|daca|tps|f-?1|j-?1|h-?1b|asylum|refugee status",
  },
  {
    topic: "income or financial aid status",
    words: "income|pell(?: grant)?|low[- ]income|fafsa|efc|sai|financial need|food stamps|snap benefits|medicaid",
    held: "pell(?: grant)?|food stamps|snap benefits|medicaid|financial aid",
  },
  { topic: "first-generation status", words: "first[- ]?gen(?:eration)?(?: college)?(?: student)?" },
  {
    topic: "race or ethnicity",
    words: "race|racial|ethnicity|black|african[- ]american|latin[oaxe]|hispanic|asian|native american|indigenous|pacific islander|biracial|multiracial|white",
  },
  {
    topic: "gender or sexual orientation",
    words: "gender|trans|transgender|nonbinary|non-binary|woman|female|lgbt\\w*|queer|gay|lesbian|bisexual|pansexual|asexual|sexual orientation",
  },
  { topic: "disability or health", words: "disab\\w*|adhd|autis\\w*|dyslexi\\w*|chronic illness|deaf|blind|neurodivergent", held: "an? (?:iep|504 plan)|accommodations" },
  { topic: "veteran or foster-care status", words: "veteran|foster care|foster youth|military service|ward of the state" },
];

/** "I am", "I'm", "I identify as", "as a": the student naming what they are. */
const SELF_IS = "(?:i am|i'm|im|i was|i've been|i have been|i identify as|identify as|as an?|being an?)";
/** "I have", "I'm on": the student naming what they hold or receive. */
const SELF_HAS = "(?:i have|i've got|i've|i hold|i receive|i get|i got|i qualify for|i'm on|i am on|i'm getting)";
/** Up to three words between the self phrase and the topic ("I'm a first generation student"). */
const GAP_3 = "(?:\\s+[\\w'-]+){0,3}?";
/** At most one word between "my" and the topic: "my family's income" yes, "my essay on race" no. */
const GAP_1 = "(?:\\s+[\\w'-]+)?";
const FAMILY = "(?:parents?|mom|mother|dad|father|family|household|guardians?)";
/** "My parents never went to college", "first in my family to go to college". */
const FIRST_GEN_PHRASES: readonly RegExp[] = [
  new RegExp(`\\b(?:my|our) ${FAMILY}\\b[^.?!;]*\\b(?:never|didn't|did not|don't|do not|haven't|have not|couldn't|could not|weren't able to)\\b[^.?!;]*\\b(?:college|university|degree|graduate)`, "i"),
  /\bfirst (?:one |person )?in my family to\b/i,
  /\bneither of my parents\b[^.?!;]*\b(?:college|university|degree)/i,
];

interface CompiledTopic {
  readonly topic: string;
  readonly patterns: readonly RegExp[];
}

function compile(t: PersonalTopic): CompiledTopic {
  const w = `(?:${t.words})`;
  const patterns = [
    new RegExp(`\\b${SELF_IS}${GAP_3}\\s+${w}\\b`, "i"),
    new RegExp(`\\b${SELF_HAS}${GAP_3}\\s+${w}\\b`, "i"),
    new RegExp(`\\bmy${GAP_1}\\s+${w}\\b`, "i"),
    new RegExp(`\\bmy ${FAMILY}(?:'s?)?(?:\\s+[\\w'-]+){0,3}?\\s+${w}\\b`, "i"),
  ];
  if (t.held) {
    // "Can I apply on a student visa?", "Do I qualify with Pell?": the student's own situation.
    patterns.push(new RegExp(`\\b(?:can|could|may|do|does|should|will|would|am)\\s+i\\b[^.?!;]*\\b(?:on|with|without|having|holding|while on)\\s+(?:an?\\s+|my\\s+)?(?:[\\w'-]+\\s+)?(?:${t.held})\\b`, "i"));
  }
  return { topic: t.topic, patterns };
}

const COMPILED: readonly CompiledTopic[] = PERSONAL_TOPICS.map(compile);

/** Curly apostrophes from phone keyboards would otherwise slip past "i'm". */
function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ");
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map(normalize).filter(Boolean);
}

/** The sensitive topic a question discloses about the asker, or null. Checked per sentence. */
export function personalDisclosure(question: string): string | null {
  for (const sentence of sentencesOf(question)) {
    if (FIRST_GEN_PHRASES.some((re) => re.test(sentence))) return "first-generation status";
    for (const { topic, patterns } of COMPILED) {
      if (patterns.some((re) => re.test(sentence))) return topic;
    }
  }
  return null;
}

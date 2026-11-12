import type { SensitiveCategory } from "../types";

/**
 * Lexicon for statements that reveal a SensitiveAnswers category. On student resumes these
 * are mostly organization, club, scholarship and program names, which a named-entity model
 * cannot classify, so the rules are explicit and auditable. The design follows NegEx-style
 * context windows (Chapman et al., 2001): a rule may require a context word within eight
 * tokens, and exclusion phrases cancel a match they overlap ("Old Navy", "React Native",
 * "Temple University", "double-blind", "Salvation Army", "SWE Intern").
 *
 * Recall beats precision here: a removed bullet costs the student a line of AI help, a missed
 * one leaks a protected trait. Every hit, definite or contextual, is removed. Novus's own
 * list; extend it with tests (sensitive.test.ts) whenever a case is missed.
 */
export interface SensitiveRule {
  id: string;
  category: SensitiveCategory;
  strength: "definite" | "contextual";
  /** Matched against one line. No `g` flag: the detector makes its own global copy. */
  pattern: RegExp;
  /** At least one match needed within eight tokens either side. */
  requires?: RegExp;
  /** Any match that overlaps the hit cancels it. */
  excludes?: readonly RegExp[];
  /** A research context ("studied", "lab", "project") makes a definite hit contextual. */
  research?: boolean;
}

const rule = (
  id: string,
  category: SensitiveCategory,
  strength: SensitiveRule["strength"],
  pattern: RegExp,
  extra: Omit<SensitiveRule, "id" | "category" | "strength" | "pattern"> = {},
): SensitiveRule => ({ id, category, strength, pattern, ...extra });

// Nationality and heritage words that, with "Student Association" and the like, name a
// heritage club. A language club ("Spanish Club") is not on this list.
const HERITAGE = [
  "African", "Caribbean", "Afro-Caribbean", "Afro-Latin[aoxe]", "Asian", "East Asian", "South Asian",
  "Southeast Asian", "Chinese", "Korean", "Japanese", "Vietnamese", "Filipin[aoxe]", "Indian", "Pakistani",
  "Bangladeshi", "Nepali", "Nepalese", "Sri Lankan", "Arab", "Persian", "Iranian", "Turkish", "Armenian",
  "Kurdish", "Nigerian", "Ghanaian", "Ethiopian", "Eritrean", "Somali", "Haitian", "Jamaican", "Mexican",
  "Puerto Rican", "Dominican", "Cuban", "Salvadoran", "Guatemalan", "Colombian", "Brazilian", "Peruvian",
  "Venezuelan", "Latin American", "Hispanic", "Hmong", "Cambodian", "Khmer", "Lao", "Laotian", "Thai",
  "Indonesian", "Malaysian", "Taiwanese", "Hong Kong", "Tibetan", "Mongolian", "Polynesian", "Hawaiian",
  "Samoan", "Tongan", "Pacific Islander", "Middle Eastern", "Palestinian", "Israeli", "Lebanese", "Egyptian",
  "Syrian", "Iraqi", "Afghan", "Ukrainian", "Russian", "Polish", "Greek", "Italian", "Irish", "Black",
  "Latin[aoxe]", "Chican[aoxe]", "Indigenous", "Native", "Desi", "Punjabi", "Sikh", "Tamil", "Telugu",
  "Gujarati", "Bengali",
].map((w) => w.replace(/ /g, "\\s+"));

const HERITAGE_CLUB = new RegExp(
  `\\b(?:${HERITAGE.join("|")})(?:[- ]American)?\\s+(?:Students?'?\\s+|Undergraduate\\s+|Graduate\\s+|Cultural\\s+|Culture\\s+|Heritage\\s+)?(?:Association|Union|Society|Alliance|Club|Organization|Council|Coalition|Collective|Network|Federation|Circle|Center|Centre)\\b`,
  "i",
);

const GREEK = "(?:Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega)";
/** Coed honor and professional societies: Greek letters, but no gender. */
const COED_SOCIETIES = new RegExp(
  `\\b(?:${[
    "Phi Beta Kappa", "Tau Beta Pi", "Phi Theta Kappa", "Alpha Lambda Delta", "Phi Eta Sigma", "Eta Kappa Nu",
    "Pi Tau Sigma", "Sigma Xi", "Beta Gamma Sigma", "Psi Chi", "Alpha Kappa Psi", "Delta Sigma Pi", "Phi Alpha Delta",
    "Alpha Phi Omega", "Omega Chi Epsilon", "Tau Sigma Delta", "Phi Sigma Pi", "Alpha Epsilon Delta", "Pi Mu Epsilon",
    "Sigma Pi Sigma", "Kappa Delta Pi", "Phi Kappa Phi", "Alpha Chi Sigma", "Theta Tau", "Lambda Pi Eta", "Sigma Tau Delta",
    "Pi Sigma Alpha", "Omicron Delta Kappa", "Omicron Delta Epsilon", "Phi Sigma Iota", "Sigma Delta Pi", "Alpha Sigma Lambda",
    "Beta Alpha Psi", "Pi Delta Phi", "Delta Phi Alpha", "Pi Kappa Lambda", "Alpha Omega Alpha", "Phi Lambda Sigma",
    "Sigma Theta Tau", "Kappa Kappa Psi", "Tau Beta Sigma", "Beta Beta Beta", "Gamma Theta Upsilon", "Phi Alpha Theta",
    "Alpha Kappa Delta", "Pi Gamma Mu", "Sigma Gamma Tau", "Chi Epsilon", "Upsilon Pi Epsilon", "Kappa Theta Pi",
    "Delta Epsilon Mu", "Alpha Epsilon Lambda", "Sigma Alpha Lambda", "Phi Delta Epsilon", "Alpha Phi Sigma",
  ].map((s) => s.replace(/ /g, "\\s+")).join("|")})\\b`,
);

export const SENSITIVE_RULES: readonly SensitiveRule[] = [
  // ---------------------------------------------------------------- citizenship and immigration
  rule("cit-citizen", "citizenship_immigration", "definite", /\b(?:U\.?\s?S\.?|United\s+States|American|Canadian|dual|naturali[sz]ed|non-?U\.?S\.?)\s+citizen(?:ship|s)?\b/i),
  rule("cit-citizenship", "citizenship_immigration", "definite", /\bcitizenship\b/i, {
    excludes: [/\b(?:digital|global|corporate|good|responsible|civic|active|world|community|school)\s+citizenship\b/i, /\bcitizenship\s+(?:award|education|curriculum|program|day)\b/i],
  }),
  rule("cit-citizen-of", "citizenship_immigration", "definite", /\bcitizen\s+of\b/i),
  rule("cit-permanent", "citizenship_immigration", "definite", /\b(?:lawful\s+)?permanent\s+residen(?:t|ts|cy|ce)\b|\bgreen[- ]card(?:\s+holders?)?\b/i),
  rule("cit-lpr-ead", "citizenship_immigration", "definite", /\bLPR\b|\bEAD\b/),
  // DACA in any case ("Daca students"); "Dreamer" stays case-sensitive so "a dreamer" survives.
  rule("cit-daca", "citizenship_immigration", "definite", /\bDACA\b|\bDREAM\s+Act\b|\bTheDream\.?US\b/i),
  rule("cit-dreamer", "citizenship_immigration", "definite", /\bDREAMers?\b|\bDreamers?\b/),
  // National origin and migration: "born in Monterrey", "moved to the US from Guatemala",
  // "my family is from", and the Spanish forms ("Mi familia es de México", "nací en").
  rule("cit-born-in", "citizenship_immigration", "definite", /\b[Bb]orn\s+(?:and\s+raised\s+)?in\s+(?:the\s+)?\p{Lu}/u),
  rule("cit-moved-to", "citizenship_immigration", "definite", /\b(?:moved|came|immigrated|emigrated|relocated|arrived|fled)\s+(?:here\s+)?(?:to|in)\s+(?:the\s+)?(?:U\.?\s?S\.?(?:A\.?)?|United\s+States|America|States|Canada|this\s+country)(?![\w])|\b(?:immigrated|emigrated|fled|migrated)\s+from\b/i),
  rule("cit-family-from", "citizenship_immigration", "definite", /\b(?:my|our)\s+(?:family|parents|mother|father|mom|dad|grandparents|ancestors)\s+(?:is|are|was|were|came|come|emigrated|immigrated)\s+(?:originally\s+)?from\b/i),
  rule("cit-spanish-origin", "citizenship_immigration", "definite", /\b(?:mi|mis|nuestra|nuestros)\s+(?:familia|padres|mam[aá]|pap[aá]|abuelos)\s+(?:es|son|era|eran|vino|vinieron|emigr[oó]|emigraron)\s+de\b|(?<![\p{L}])(?:soy|somos|vengo|venimos)\s+de\s+\p{Lu}|(?<![\p{L}])nac[ií]\s+en\b/iu),
  rule("cit-undocumented", "citizenship_immigration", "definite", /\bundocumented\b/i),
  rule("cit-asylum", "citizenship_immigration", "definite", /\basyl(?:um|ees?)\b|\brefugees?\b/i),
  rule("cit-tps", "citizenship_immigration", "contextual", /\bTPS\b/, {
    requires: /\b(?:temporary|protected|status|holders?|recipients?|beneficiar\w*|immigration)\b/i,
  }),
  rule("cit-work-auth", "citizenship_immigration", "definite", /\b(?:work|employment)\s+authori[sz]ation\b|\bauthori[sz]ed\s+to\s+work\b|\beligible\s+to\s+work\s+in\b/i),
  rule("cit-sponsorship", "citizenship_immigration", "contextual", /\bsponsorships?\b/i, {
    requires: /\b(?:visas?|immigration|H-?1B|F-?1|OPT|CPT|authori[sz]ation|requir\w*|need\w*)\b/i,
    excludes: [
      /\b(?:corporate|event|industry|company|club|team|hackathon|conference|title|brand)\s+sponsorships?\b/i,
      /\bsponsorships?\s+(?:from|for|of|with|outreach|packages?|decks?|team|chair|coordinator|director|lead|committee|revenue|opportunities)\b/i,
    ],
  }),
  rule("cit-visa", "citizenship_immigration", "contextual", /\bvisas?\b/i, {
    requires: /\b(?:student|work|status|sponsor\w*|holders?|type|immigration|F-?1|J-?1|H-?1B|O-?1|L-?1|application|expir\w*|stamp|interview|category)\b/i,
    excludes: [/\bVisa\s+(?:Inc\.?|Card|Payments|Direct|Checkout|Signature|Infinite)\b/, /\b(?:at|with|for|by|from|joined)\s+Visa\b/],
  }),
  rule("cit-f1", "citizenship_immigration", "contextual", /\b[FJM]-?1\b/, {
    requires: /\b(?:visas?|status|students?|authori[sz]ation|OPT|CPT|SEVIS|I-?20|DS-?2019|holders?|international)\b/i,
    excludes: [/\bF-?1[\s-]*(?:scores?|measures?|metrics?)\b/i, /\bFormula\s*(?:1|One)\b/i, /\bF1\s+(?:racing|car|team|race|grand\s+prix)\b/i, /\bmacro[- ]F1\b/i, /\bF1\s*[=:]/],
  }),
  rule("cit-opt-cpt", "citizenship_immigration", "contextual", /\b(?:STEM\s+)?OPT\b|\bCPT\b/, {
    requires: /\b(?:visas?|status|F-?1|students?|authori[sz]ation|eligib\w*|work|employment|EAD|international|STEM)\b/i,
    excludes: [/\bCPT\s+(?:cod(?:e|es|ing)|billing)\b/i],
  }),
  rule("cit-forms", "citizenship_immigration", "definite", /\bH-?1-?B\b|\bI-?20\b|\bSEVIS\b|\bDS-?2019\b|\bI-?94\b|\bI-?765\b|\bI-?485\b|\bdeferred\s+action\b|\bA-?Number\b|\balien\s+registration\b|\bUSCIS\b|\bnaturali[sz]ation\b/i),
  rule("cit-international", "citizenship_immigration", "contextual", /\binternational\s+students?\b|\bnationality\b|\bimmigrants?\b|\bimmigrat(?:ed|ion|ing)\b|\bemigra(?:ted|nts?|tion)\b|\bmigrants?\b/i),
  rule("cit-english-learner", "citizenship_immigration", "contextual", /\b(?:ESL|ELL|ESOL)\s+(?:students?|programs?|classes|class|learners?|courses?)\b|\bEnglish\s+(?:language\s+)?learners?\b|\bEnglish\s+as\s+a\s+(?:second|new|foreign|additional)\s+language\b|\bIntensive\s+English\s+(?:Program|Institute)\b|\bnewcomer\s+(?:students?|programs?)\b/i),

  // ---------------------------------------------------------------- income
  rule("inc-low-income", "income", "definite", /\blow(?:er)?[- ](?:middle[- ])?income\b|\bunder-?resourced\s+(?:family|families|household|background)\b/i),
  rule("inc-pell", "income", "definite", /\bPell\b/i, { excludes: [/\bPell\s+City\b/i] }),
  rule("inc-aid-forms", "income", "definite", /\bFAFSA\b|\bStudent\s+Aid\s+Index\b|\bExpected\s+Family\s+Contribution\b|\bCSS\s+Profile\b/i),
  rule("inc-sai-efc", "income", "contextual", /\b(?:SAI|EFC)\b/, { requires: /\b(?:aid|FAFSA|index|contribution|financial|zero|need)\b/i }),
  rule("inc-lunch", "income", "definite", /\bfree\s*(?:or|and|\/|&)\s*reduced(?:[- ]price)?\s+(?:school\s+)?(?:lunch|meals?|breakfast)\b|\breduced[- ]price\s+(?:lunch|meals?)\b|\bfree\s+(?:school\s+)?lunch\b/i),
  rule("inc-work-study", "income", "definite", /\b(?:federal\s+)?work[- ]study\b/i),
  rule("inc-fws", "income", "contextual", /\bFWS\b/, { requires: /\b(?:work|aid|federal|campus|job)\b/i }),
  rule("inc-programs", "income", "contextual", /\bQuestBridge\b|\bJack\s+Kent\s+Cooke\b|\bDell\s+Scholars?\b|\bHoratio\s+Alger\b|\bGates\s+(?:Millennium\s+)?Scholar(?:s|ship)?\b|\bPosse\s+(?:Scholars?|Foundation|Program)\b|\bUpward\s+Bound\b|\bEducational\s+Opportunity\s+(?:Program|Fund)\b|\bStudent\s+Support\s+Services\b|\bSEO\s+Scholars?\b|\bCollege\s+Possible\b|\bCollegePoint\b|\bOpportunity\s+Scholars?\b/i),
  rule("inc-program-acronyms", "income", "contextual", /\bTRIO\b|\bEOPS?\b|\bGEAR\s+UP\b|\bAVID\b/),
  rule("inc-benefits", "income", "contextual", /\b(?:SNAP|WIC|TANF)\b/),
  rule("inc-benefits-words", "income", "contextual", /\bfood\s+stamps\b|\bMedicaid\b|\bpublic\s+assistance\b|\bsection\s+8\s+housing\b|\bpublic\s+housing\b|\bwelfare\s+(?:benefits|recipient)\b/i),
  rule("inc-need", "income", "contextual", /\bfinancial\s+(?:need|hardship|aid\s+recipient)\b|\bneed[- ]based\b|\bhousing\s+insecur\w*|\bfood\s+insecur\w*|\bexperienced\s+homelessness\b|\bunhoused\b|\bhomeless\s+(?:youth|student)\b|\bpoverty\b/i),
  // Self-funding and family-support statements reveal income as surely as "low-income".
  rule("inc-self-funded", "income", "definite", /\bpaid\s+(?:for\s+)?(?:my\s+own\s+|my\s+)?(?:tuition|college|school|way\s+through)(?:\s+myself)?\b|\bself[- ]fund(?:ed|ing)\s+(?:my\s+)?(?:education|tuition|college|degree)\b|\b(?:worked|work|working)\s+to\s+support\s+my\s+family\b|\bsupport(?:ed|ing)?\s+my\s+family\s+financially\b|\bhelp(?:ed|ing)?\s+(?:to\s+)?pay\s+(?:my\s+family'?s\s+|our\s+)?(?:rent|bills)\b/i),
  // A first-person stay cancels the "homeless shelter" exclusion below: "the shelter where I lived".
  rule("inc-homeless-first-person", "income", "definite", /\bhomeless(?:ness)?\b/i, {
    requires: /\b(?:I|we|my\s+family|my\s+mom|my\s+mother|my\s+dad|my\s+father)\s+(?:\w+\s+)?(?:lived|live|living|stayed|stay|staying|slept|was|were)\b/i,
  }),
  rule("inc-homeless", "income", "contextual", /\bhomeless(?:ness)?\b/i, {
    excludes: [
      /\bhomeless\s+(?:shelters?|outreach|services|coalition|population|individuals|people|neighbors|veterans|families|clients|community|programs?|alliance)\b/i,
      /\b(?:serv(?:ed|ing|e)|support(?:ed|ing)?|help(?:ed|ing)?|assist(?:ed|ing)?|feed(?:ing)?|fed|for|with|to)\s+(?:the\s+)?homeless\b/i,
    ],
  }),

  // ---------------------------------------------------------------- disability
  rule("dis-disability", "disability", "definite", /\bdisabilit(?:y|ies)\b|\bdisabled\b|\bdifferently[- ]abled\b|\bhandicapp?ed\b/i, {
    research: true,
    excludes: [
      /\bdisabled\s+(?:buttons?|states?|fields?|inputs?|features?|flags?|modes?|by\s+default|the|it|them|this|that|access|accounts?|logging|caching|cookies|javascript|notifications?|links?|options?|settings?)\b/i,
      /\b(?:was|were|is|are|be|been|got|get|gets|remain(?:s|ed)?)\s+disabled\b/i,
      /\b(?:enabled|enable)\s*(?:\/|and|or)\s*disabled\b/i,
      // A bullet that opens with "Disabled" is the verb ("Disabled unused features"), unless
      // people follow it.
      /^\s*(?:[-•*]\s*)?Disabled\b(?!\s+(?:students?|veterans?|people|persons?|individuals|adults|youth|children|kids|athletes?|community|members?|American))/i,
    ],
  }),
  rule("dis-conditions", "disability", "definite", /\bADHD\b|\bautis(?:m|tic)\b|\bAsperger'?s?\b|\bdyslexi(?:a|c)\b|\bdyscalculia\b|\bdyspraxia\b|\bneurodiver(?:gent|gence|se|sity)\b|\bcerebral\s+palsy\b|\bspina\s+bifida\b|\bmuscular\s+dystrophy\b|\bDown\s+syndrome\b|\bTourette'?s?\b|\bvisually\s+impaired\b|\bvisual\s+impairments?\b|\blow\s+vision\b|\bhearing\s+(?:impair(?:ed|ments?)|loss)\b|\bhard\s+of\s+hearing\b|\bwheelchairs?(?:\s+users?)?\b|\bamputee\b|\blearning\s+(?:disabilit\w+|differences?)\b|\bon\s+the\s+(?:autism\s+)?spectrum\b|\bchronic\s+pain\b|\bmobility\s+impairments?\b|\bspeech\s+impediments?\b|\bstutter(?:ing)?\b/i, {
    research: true,
  }),
  rule("dis-deaf", "disability", "definite", /\bdeaf(?:ness)?\b/i, { research: true, excludes: [/\bdeaf\s+ears\b/i] }),
  rule("dis-blind", "disability", "definite", /\bblind(?:ness)?\b/i, {
    research: true,
    excludes: [
      /\b(?:double|single|triple)[- ]blind(?:ed)?\b/i,
      /\bblind(?:ed)?\s+(?:review|reviewed|study|studies|trials?|tests?|testing|tasting|spots?|dates?|auditions?|grading|grader|signal|copy|carbon|cc|analysis|evaluation|coding|scoring)\b/i,
      /\bcolou?r[- ]?blind(?:ness)?\s+(?:friendly|safe|accessible|mode|simulation)\b/i,
      /\bblind[- ]spots?\b/i,
    ],
  }),
  rule("dis-plans", "disability", "definite", /\bIEP\b|\b504\s+[Pp]lan\b|\bSection\s+504\b/),
  rule("dis-accommodations", "disability", "contextual", /\baccommodations?\b/i, {
    requires: /\b(?:disabilit\w*|ODS|SDS|DRC|DSS|testing|exams?|504|IEP|ADA|accessibility\s+services|student\s+access|extended\s+time)\b/i,
    excludes: [/\b(?:hotel|guest|travel|housing|lodging)\s+accommodations?\b/i],
  }),
  rule("dis-offices", "disability", "definite", /\b(?:Disability|Accessibility|Access)\s+(?:Resources?|Services|Center|Centre|Office)\b|\bOffice\s+(?:of|for)\s+(?:Disability|Accessibility|Student\s+Access)\b/i),
  rule("dis-devices", "disability", "definite", /\bhearing\s+aids?\b|\bcochlear\s+implants?\b|\bwhite\s+cane\b|\b(?:use|uses|used|using|with)\s+a\s+(?:cane|walker|wheelchair|service\s+(?:dog|animal))\b|\bservice\s+dog\s+(?:handler|user)\b|\bscreen[- ]reader\s+users?\b|\b(?:I\s+)?use\s+(?:a\s+)?screen[- ]readers?\b|\bprosthe(?:tic|sis)\s+(?:user|leg|arm|limb)\b|\bsled\s+hockey\b|\bwheelchair\s+(?:basketball|rugby|tennis)\b|\bgoalball\b|\bblind\s+soccer\b/i),
  rule("dis-adaptive", "disability", "contextual", /\bSpecial\s+Olympics\b|\bBest\s+Buddies\b|\bParalympic\w*\b|\badaptive\s+(?:sports?|athletics)\b/i),

  // ---------------------------------------------------------------- race and ethnicity
  rule("re-terms", "race_ethnicity", "definite", /\bAfrican[- ]Americans?\b|\bAfro[- ](?:Latin[aoxe]s?|Caribbean|Americans?)\b|\bHispanics?\b|\bLatin[aoxe]s?\b|\bLatin[ao]\/[ao]\b|\bChican[aoxe]s?\b|\bAsian[- ]Americans?\b|\bAsian\s+Pacific\b|\bPacific\s+Islanders?\b|\bNative\s+(?:American|Hawaiian|Alaskan)s?\b|\bAlaska\s+Natives?\b|\bAmerican\s+Indians?\b|\bFirst\s+Nations\b|\bmultiracial\b|\bbiracial\b|\bmixed[- ]race\b|\b(?:people|students?|women|men|youth|communities)\s+of\s+colou?r\b|\bMiddle\s+Eastern\b|\bArab[- ]Americans?\b|\b(?:ethnic|racial)\s+minorit(?:y|ies)\b|\bethnicity\b|\bunderrepresented\s+minorit(?:y|ies)\b/i),
  rule("re-underrepresented", "race_ethnicity", "contextual", /\bunderrepresented\b|\bminorit(?:y|ies)\b|\bdiversity\s+scholar(?:s|ship)?\b/i, {
    excludes: [/\bminority\s+(?:stake|stakes|shareholders?|interest|owners?|investors?|report|leader|whip)\b/i],
  }),
  // Latina/Latino and Chicana affinity names, and plain race labels.
  rule("re-affinity", "race_ethnicity", "definite", /\bMujeres\b|\bHermanas\b|\bLa\s+Raza\b|\bLatinidad\b|\bHispan[ao]s?\b|\bCaucasian\b|\bnon-?Hispanic\s+White\b|\bWhite\s*(?:\/|,|and)\s*(?:Hispanic|Asian|Latin\w*|Black)\b|\bWhite\s+(?:non-Hispanic|American|European|female|male|woman|man)\b/i),
  rule("re-asian", "race_ethnicity", "contextual", /\bAsian\b/, {
    excludes: [/\bAsian\s+(?:Studies|Languages?|History|Art|Arts|markets?|cuisine|food|economies|economics|Development\s+Bank|Pacific\s+(?:region|markets?)|Games|Cup)\b/i],
  }),
  rule("re-native", "race_ethnicity", "definite", /\bNative\s+(?:students?|communit(?:y|ies)|nations?|youth|peoples?|families|heritage|cultures?|ancestry)\b/i),
  rule("re-indigenous", "race_ethnicity", "definite", /\bIndigenous\b/i, {
    excludes: [/\bindigenous\s+(?:plants?|species|flora|fauna|crops?|vegetation|trees?|microbes?|bacteria|grasses|wildlife)\b/i],
  }),
  rule("re-acronyms", "race_ethnicity", "definite", /\bAAPI\b|\bAPIDA\b|\bBIPOC\b|\bURM\b|\bHBCUs?\b|\bHSI\b|\bNSBE\b|\bSHPE\b|\bSACNAS\b|\bAISES\b|\bMAES\b|\bUNCF\b|\bNABJ\b|\bNAHJ\b|\bAAJA\b|\bALPFA\b|\bINROADS\b|\bLSAMP\b|\bNAACP\b|\bLULAC\b|\bMEChA\b/),
  rule("re-poc", "race_ethnicity", "contextual", /\bPOC\b/, {
    requires: /\b(?:students?|women|men|community|people|queer|affinity|caucus|alliance|leaders?|colou?r|scholars?)\b/i,
    excludes: [/\bPOCs?\s+(?:for|of|to|that|demo|app|project|code|build|stage)\b/i, /\b(?:a|the|built|developed|created|delivered|prototyped?|shipped)\s+(?:a\s+)?POCs?\b/i],
  }),
  rule("re-mena", "race_ethnicity", "contextual", /\bMENA\b/),
  rule("re-bsu", "race_ethnicity", "contextual", /\bBSU\b/, {
    requires: /\b(?:Black|Student\s+Union|members?|president|vice|treasurer|secretary|board|chair|officer|events?)\b/i,
  }),
  rule("re-mlt", "race_ethnicity", "contextual", /\bMLT\b/, {
    requires: /\b(?:Management\s+Leadership|fellows?|Career\s+Prep|Rising\s+Leaders|Ascend|CP)\b/i,
  }),
  rule("re-orgs", "race_ethnicity", "contextual", /\bNational\s+Society\s+of\s+Black\s+Engineers\b|\bSociety\s+of\s+Hispanic\s+Professional\s+Engineers\b|\bHispanic\s+Scholarship\s+Fund\b|\bThurgood\s+Marshall\b|\bRon\s+Brown\s+Scholars?\b|\bJackie\s+Robinson\s+(?:Foundation|Scholars?)\b|\bMeyerhoff\b|\bLouis\s+Stokes\b|\bBlack\s+Girls\s+Code\b|\bCode2040\b|\bManagement\s+Leadership\s+for\s+Tomorrow\b|\bPrep\s+for\s+Prep\b|\bA\s+Better\s+Chance\b|\bLEDA\s+Scholars?\b|\bColor\s+of\s+Change\b|\bBlack\s+Lives\s+Matter\b|\bBlack\s+History\s+Month\b|\bHispanic\s+Heritage\s+Month\b|\bJuneteenth\b/i),
  rule("re-heritage-club", "race_ethnicity", "contextual", HERITAGE_CLUB),
  // Capitalized "Black" mid-sentence is far more often an identity than a colour on a resume,
  // so it needs no context word; the known look-alikes are excluded.
  rule("re-black", "race_ethnicity", "contextual", /\bBlack\b/, {
    excludes: [
      /\bBlack[- ](?:belts?|box|holes?|Friday|Mirror|Hat|Swan|Forest|Sea|Mesa|Duck|Panthers?|Widow|Knight|Diamond|ice|mold|light|market|tie|Lab|Hills|Rock|Hawks?|Bear|Bean|Desert|Canyon|Butte|Mountain|Lake|River|Point|Creek)\b/i,
      /\bBlack[- ]Scholes\b/i,
      /\bBlack\s+(?:and|&)\s+(?:White|Decker|Veatch|Gold)\b/i,
      /\bin\s+the\s+black\b/i,
      /\b(?:Jack|Jet|Pitch|Matte)\s+Black\b/i,
    ],
  }),
  rule("re-hbcu-names", "race_ethnicity", "contextual", /\b(?:Morehouse|Spelman|Tuskegee|Claflin|Grambling|Bethune[- ]Cookman|FAMU)\b|\b(?:Howard|Hampton|Fisk|Dillard|Clark\s+Atlanta|Jackson\s+State|Morgan\s+State|Bowie\s+State|Delaware\s+State|Norfolk\s+State|Coppin\s+State|Texas\s+Southern|Alabama\s+State|Tennessee\s+State|Winston[- ]Salem\s+State|Fayetteville\s+State|Albany\s+State|Fort\s+Valley\s+State|Savannah\s+State|Virginia\s+State|Kentucky\s+State|Elizabeth\s+City\s+State|Southern|Lincoln)\s+University\b|\b(?:Prairie\s+View|Florida|North\s+Carolina|NC|Alabama)\s+A&[MT]\b|\bXavier\s+University\s+of\s+Louisiana\b/),

  // Form-style labels: any value after "Gender:", "Race:" and the like is a disclosure, even a
  // single letter ("Gender: F", "Sex: M").
  rule("lbl-gender", "gender", "definite", /\b(?:Gender|Sex)\s*(?::|\s[-–]\s)\s*\S/),
  rule("lbl-race", "race_ethnicity", "definite", /\b(?:Race|Ethnicity|Ethnic\s+background)\s*(?::|\s[-–]\s)\s*\S/i),
  rule("lbl-religion", "religion", "definite", /\b(?:Religion|Faith|Religious\s+affiliation)\s*(?::|\s[-–]\s)\s*\S/i),
  rule("lbl-citizenship", "citizenship_immigration", "definite", /\b(?:Nationality|Citizenship|Immigration\s+status|Visa\s+status|Country\s+of\s+(?:birth|origin))\s*(?::|\s[-–]\s)\s*\S/i),
  rule("lbl-other", "health", "definite", /\b(?:Disability(?:\s+status)?|Veteran\s+status|Sexual\s+orientation|Marital\s+status|Medical\s+conditions?)\s*(?::|\s[-–]\s)\s*\S/i),

  // ---------------------------------------------------------------- tribal affiliation
  rule("tri-tribal", "tribal_affiliation", "contextual", /\btrib(?:e|es|al)\b/i, {
    requires: /\b(?:members?|enrolled|enrollment|citizens?|nations?|council|college|government|affiliation|ID|lands?|reservations?|elders?|youth|sovereignty|Native|Indian|heritage|language)\b/i,
    excludes: [/\btribal\s+knowledge\b/i, /\bfind\s+your\s+tribe\b/i],
  }),
  rule("tri-documents", "tribal_affiliation", "definite", /\bCDIB\b|\bCertificate\s+of\s+Degree\s+of\s+Indian\s+Blood\b|\bBureau\s+of\s+Indian\s+(?:Affairs|Education)\b|\btribal\s+(?:colleges?|citizenship|enrollment|member(?:ship)?)\b/i),
  rule("tri-nations", "tribal_affiliation", "contextual", /\b(?:Cherokee|Navajo|Diné|Lakota|Dakota|Ojibwe|Chippewa|Choctaw|Chickasaw|Muscogee|Seminole|Apache|Hopi|Zuni|Pueblo|Haudenosaunee|Iroquois|Mohawk|Oneida|Seneca|Blackfeet|Sioux|Comanche|Kiowa|Osage|Pawnee|Potawatomi|Menominee|Ho-Chunk|Lumbee|Tlingit|Yup'?ik|Inupiat|Iñupiat|Aleut|Shoshone|Paiute|Ute|Arapaho|Cheyenne|Nez\s+Perce|Yakama|Tohono\s+O'odham|Lenape|Wampanoag|Narragansett|Pequot|Shinnecock|Anishinaabe|Cree|Métis|Inuit)\b/, {
    requires: /\b(?:Nations?|Tribes?|Tribal|Band|Reservations?|Indian|Native|enrolled|citizens?|heritage|language|Rancheria|elders?|people)\b/i,
    excludes: [
      /\bApache\s+(?:Kafka|Spark|Hadoop|Tomcat|HTTP|Airflow|Beam|Flink|Cassandra|Maven|Solr|Lucene|Superset|NiFi|Commons|License|Software|Foundation|Struts|Pig|Hive|Storm|Arrow|Iceberg|Pulsar|Druid|Camel|Groovy|Ant|Ignite|Zookeeper|OpenOffice|web\s+server|server)\b/i,
      /\b(?:North|South)\s+Dakota\b/,
      /\bSeneca\s+(?:College|Falls)\b/,
    ],
  }),
  rule("tri-reservation", "tribal_affiliation", "contextual", /\breservations?\b/i, {
    requires: /\b(?:Indian|Native|tribal|tribe|Nation|Pueblo|Navajo|Lakota|Cherokee)\b/i,
  }),

  // ---------------------------------------------------------------- gender
  rule("gen-pronouns", "gender", "definite", /\b(?:she|he|they|ze|xe|ey)\s*\/\s*(?:her|him|them|hir|zir|xem|em|they|she|he)(?:\s*\/\s*(?:hers|his|theirs|hirs|zirs|xyrs|eirs))?\b|\bpronouns?\s*:|\bpronouns\b/i),
  rule("gen-pronouns-es", "gender", "definite", /(?<![\p{L}])(?:ella|[ée]l|elle)\s*\/\s*(?:she|he|they|her|him|them|ella|[ée]l|elle)(?![\p{L}])|(?<![\p{L}])(?:she|he|they)\s*\/\s*(?:ella|[ée]l|elle)(?![\p{L}])/iu),
  rule("gen-identity", "gender", "definite", /\btransgender\b|\btrans\s+(?:man|woman|men|women|students?|youth|people|person|community)\b|\bnon[- ]?binary\b|\bgenderqueer\b|\bgender[- ](?:fluid|nonconforming|non-conforming|expansive|diverse|queer)\b|\bgender\s+identity\b|\bintersex\b|\bcisgender\b/i),
  rule("gen-orgs", "gender", "definite", /\bSociety\s+of\s+Women\s+Engineers\b|\bWomen\s+in\s+(?:Computing|Computer\s+Science|CS|STEM|Engineering|Tech(?:nology)?|Business|Science|Physics|Math(?:ematics)?|Data(?:\s+Science)?|Finance|Economics|Medicine|Law|Cyber(?:security)?|Robotics|AI|Machine\s+Learning|Leadership|Politics|Product|Design)\b|\bGirls\s+Who\s+Code\b|\bGirls\s+in\s+(?:Tech|STEM)\b|\bAnitaB(?:\.org)?\b|\bGrace\s+Hopper\s+Celebration\b|\bRewriting\s+the\s+Code\b|\bBuilt\s+By\s+Girls\b|\bGirl\s+Scouts?\b|\bGirl\s+Up\b|\bsororit(?:y|ies)\b|\bfraternit(?:y|ies)\b|\bPanhellenic\b|\bInterfraternity\s+Council\b|\bWom[ae]n'?s\s+(?:Leadership|Network|Center|Caucus|Collective|Initiative|Conference|Empowerment|Club|Society|Association|College|Forum|Circle|Council|Alliance)\b|\bwom[ae]n'?s\s+(?:rugby|soccer|basketball|volleyball|lacrosse|tennis|swim(?:ming)?|track|crew|rowing|hockey|softball|golf|cross[- ]country|ultimate|water\s+polo|fencing|gymnastics|squash|team|varsity|a\s+cappella|choir|chorus)\b|\bmen'?s\s+(?:rugby|soccer|basketball|volleyball|lacrosse|tennis|swim(?:ming)?|track|crew|rowing|hockey|baseball|golf|cross[- ]country|ultimate|water\s+polo|fencing|gymnastics|squash|team|varsity|club|choir|chorus|a\s+cappella|glee)\b|\ball[- ](?:girls?|boys?|wom[ae]n'?s|men'?s)\s+(?:school|academy|college)\b/i),
  rule("gen-acronyms", "gender", "contextual", /\bWiCS\b|\bWiSTEM\b|\bWiE\b|\bWiB\b|\bWiDS\b|\bGHC\b|\bBoy\s+Scouts?\b|\bEagle\s+Scout\b|\bGold\s+Award\b/),
  rule("gen-swe", "gender", "contextual", /\bSWE\b/, {
    excludes: [
      /\bSWE[\s-]+(?:Intern(?:ship)?s?|I{1,3}|[123]|Co-?op|Fellow(?:ship)?|New\s+Grad|roles?|positions?|team|Engineer|interviews?|Apprentice(?:ship)?|work)\b/i,
      /\b(?:Software|Senior|Junior|Staff|Principal|Backend|Back-end|Frontend|Front-end|Full[- ]?Stack|Mobile|ML|Data|Platform|Infra)\s+SWE\b/i,
      /\bSWE\s*@/,
    ],
  }),
  rule("gen-greek", "gender", "contextual", new RegExp(`\\b${GREEK}(?:\\s+${GREEK}){1,2}\\b`), { excludes: [COED_SOCIETIES] }),
  rule("gen-words", "gender", "contextual", /\bwom[ae]n(?:'s)?\b|\bfemales?\b|\bmales?\b/i),

  // ---------------------------------------------------------------- sexual orientation
  rule("so-terms", "sexual_orientation", "definite", /\bLGBT\w*\+?|\bqueer\b|\bgay\b|\blesbians?\b|\bbisexual\b|\bpansexual\b|\basexual\b|\bQTPOC\b|\bQTBIPOC\b|\btwo[- ]spirit\b|\bsexual\s+orientation\b|\bsame[- ]sex\b|\bsexualit(?:y|ies)\b/i, {
    research: true,
    excludes: [/\bGay[- ]Lussac\b/i, /\basexual\s+(?:reproduction|propagation|spores?|organisms?|lineages?|strains?)\b/i],
  }),
  rule("so-orgs", "sexual_orientation", "definite", /\boSTEM\b|\bOut\s+in\s+(?:Tech|STEM|Science|Business|Law)\b|\bOut\s+for\s+Undergrad\b|\bO4U\b|\bPoint\s+(?:Foundation|Scholars?)\b|\bTrevor\s+Project\b|\bGLSEN\b|\bGLAAD\b|\bHuman\s+Rights\s+Campaign\b|\bGay[- ]Straight\s+Alliance\b|\bGender\s+(?:and|&)\s+Sexuality\s+Alliance\b|\bQueer[- ]Straight\s+Alliance\b|\bSafe\s+Zone\b|\bNOGLSTP\b|\bReaching\s+Out\s+MBA\b|\bROMBA\b|\bLavender\s+(?:Graduation|Ceremony|Scholars?)\b|\bStonewall\b|\bRainbow\s+(?:Alliance|Coalition|Club|Center)\b/),
  rule("so-pride", "sexual_orientation", "contextual", /\bPride\b/, {
    requires: /\b(?:LGBT\w*|queer|club|alliance|month|center|centre|network|week|parade|march|committee|festival|flag|collective|council|coalition|union|organization|society)\b/i,
    excludes: [/\bPride\s+and\s+Prejudice\b/i, /\b(?:school|team|community|Panther|Lion|Tiger)\s+Pride\b/i],
  }),
  rule("so-gsa", "sexual_orientation", "contextual", /\bGSA\b/, { requires: /\b(?:gender|sexuality|alliance|queer|LGBT\w*|gay|straight|pride)\b/i }),

  // ---------------------------------------------------------------- religion
  rule("rel-terms", "religion", "definite", /\b(?:Christian(?:ity|s)?|Catholic(?:ism|s)?|Protestant|Evangelical|Baptist|Methodist|Lutheran|Presbyterian|Episcopal(?:ian)?|Pentecostal|Anglican|Mormon|Latter[- ]day\s+Saints?|Jehovah'?s\s+Witness(?:es)?|Jewish|Judaism|Jews|Muslims?|Islam(?:ic)?|Hindu(?:ism|s)?|Sikh(?:ism|s)?|Buddhis[mt]s?|Zoroastrian|Atheis[mt]s?|Agnostic|Quaker|Mennonite|Amish|Adventist|Unitarian|Orthodox\s+(?:Christian|Church|Jewish|Judaism)|Bah[aá]'?[ií]s?|Bahai|Ahmadiyy?a|Ahmadi|Isma'?ili|Shi'?a|Shi'?ite|Shiite|Sunnis?|Coptic|Copts?|(?:Greek|Eastern|Russian|Serbian|Armenian|Ethiopian|Eritrean|Antiochian|Syriac)\s+Orthodox|Wicca|Wiccans?|Pagan(?:ism|s)?|Neopagan|Druze|Rastafari(?:an)?|Shinto|Taois[mt]|Daois[mt]|Tenrikyo|Cao\s+Dai|Yazidi|Mandaean)\b/i),
  // Accented and curly-apostrophe spellings need Unicode-aware edges: "\b" does not see "í" as a letter.
  rule("rel-unicode", "religion", "definite", /(?<![\p{L}])(?:Bah[aá]['’]?[ií]s?|Shi['’]a|Shi['’]ite|Isma['’]ili|Jumu['’]ah|Qur['’]an)(?![\p{L}])/iu),
  rule("rel-practices", "religion", "definite", /\bSangha\b|\bKirtan\b|\bBhakti\b|\bhijab(?:i|s)?\b|\bniqab\b|\bhalal\b|\bkosher\b|\bShabbat\b|\bShabbos\b|\bSabbath\b|\bJumu'?ah\b|\bJumma\b|\bFriday\s+prayers?\b|\bSalah\b|\bcatechesis\b|\bcatechists?\b|\bDivinity\b|\bBiblical\s+Studies\b|\bReligious\s+Studies\b|\bSeventh[- ]day\b|\bSatsang\b|\bGurbani\b|\bLangar\b|\bPuja\b|\bDharma\s+(?:club|talks?|group|society)\b|\bMeditation\s+(?:Group|Society)\s+\(?Buddhist\b/i),
  rule("rel-jain", "religion", "contextual", /\bJain(?:ism|s)?\b/, {
    requires: /\b(?:temple|community|society|association|center|centre|students?|faith|religion|religious|derasar|pathshala|Jainism)\b/i,
  }),
  rule("rel-orgs", "religion", "definite", /\bHillel\b|\bChabad\b|\bMuslim\s+Students?'?\s+Association\b|\bInterVarsity\b|\bIVCF\b|\bCampus\s+Crusade\b|\bNewman\s+(?:Center|Centre|Club|Catholic|Community|Association)\b|\bFellowship\s+of\s+Christian\s+(?:Athletes|Students)\b|\bYoung\s+Life\b|\bYouth\s+(?:Group|Ministry)\b|\bCampus\s+Ministr(?:y|ies)\b|\bchurch(?:es)?\b|\bmosques?\b|\bmasjid\b|\bsynagogues?\b|\bgurdwaras?\b|\b(?:arch)?diocese\b|\bcongregations?\b|\bmission\s+trips?\b|\bmissionar(?:y|ies)\b|\bworship\b|\bpraise\s+(?:team|band)\b|\bSunday\s+School\b|\bVacation\s+Bible\s+School\b|\bBar\s+Mitzvah\b|\bBat\s+Mitzvah\b|\bB'nai\s+B'rith\b|\bBBYO\b|\bNCSY\b|\bQur'?an\b|\bKoran\b|\bTorah\b|\bTalmud\b|\bYeshiva\b|\bMadrass?ah?\b|\bseminary\b|\btheolog(?:y|ical)\b|\bpastor(?:al)?\b|\brabbi(?:nical)?\b|\bimam\b|\bpriest(?:hood)?\b|\bdeacon\b|\baltar\s+server\b|\bacolyte\b|\bcatechism\b|\bconfirmation\s+class\b/i, {
    excludes: [/\bChurch\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?)\b/i],
  }),
  rule("rel-observances", "religion", "contextual", /\bBible\b|\bparish(?:es)?\b|\bRamadan\b|\bIftar\b|\bJummah\b|\bDiwali\b|\bPassover\b|\bRosh\s+Hashanah\b|\bYom\s+Kippur\b|\bHanukkah\b|\bVaisakhi\b|\binterfaith\b|\bfaith[- ]based\b|\breligio(?:n|us)\b|\bspiritual\s+life\b|\bchaplain(?:cy)?\b/i),
  rule("rel-acronyms", "religion", "contextual", /\bCru\b|\bEid\b/),
  rule("rel-fca", "religion", "contextual", /\bFCA\b/, { requires: /\b(?:Christian|Fellowship|athletes|huddle|faith)\b/i }),
  rule("rel-temple", "religion", "contextual", /\btemples?\b/i, {
    excludes: [/\bTemple\s+(?:University|Run|Grandin|Bar|Health|Hospital|Owls|Terrace|City)\b/i, /\bShirley\s+Temple\b/i, /\btemple\s+of\s+doom\b/i],
  }),
  rule("rel-ministry", "religion", "contextual", /\bministr(?:y|ies)\b/i, {
    excludes: [/\bMinistry\s+of\s+(?:Education|Health|Finance|Defen[cs]e|Foreign|Agriculture|Trade|Industry|Transport|Energy|Labou?r|Justice|Interior|Science|Culture|Environment|Economy|Tourism|Communications?|Commerce|Information|Youth)\b/i],
  }),
  rule("rel-msa", "religion", "contextual", /\bMSA\b/, { requires: /\b(?:Muslim|Islam\w*|Ramadan|Eid|mosque|masjid|Jummah|halal|iftar|interfaith)\b/i }),
  // Bare "LDS" on a student resume names the church far more often than anything else.
  rule("rel-lds", "religion", "definite", /\bLDS\b/),

  // ---------------------------------------------------------------- first-generation
  rule("fg-terms", "first_generation", "definite", /\bfirst[- ]?gen(?:eration)?\b|\b1st[- ]gen(?:eration)?\b|\bFGLI\b|\bfirst\s+(?:in|of)\s+(?:(?:my|their|his|her|our|the)\s+)?(?:immediate\s+)?family\s+to\s+(?:attend|go\s+to|graduate|enroll|apply|earn|complete|pursue|study)\b|\bfirst\s+(?:in|of)\s+(?:(?:my|their|his|her|our)\s+)?family\s+(?:in|at)\s+(?:college|university)\b|\bfirst\s+(?:person|one|member)\s+in\s+(?:my|their|his|her)\s+family\b|\bFirst\s+Scholars?\b|\bMcNair(?:\s+Scholars?)?\b/i, {
    excludes: [/\bfirst[- ]?gen(?:eration)?\s+(?:iPhone|iPad|products?|prototypes?|devices?|models?|hardware|Pixel|Kindle|sequencing|antihistamines?|antipsychotics?|EVs?|vehicles?|chips?|consoles?|biofuels?)\b/i],
  }),

  // ---------------------------------------------------------------- veteran and military
  rule("vet-terms", "veteran", "definite", /\bveterans?\b|\bG\.?I\.?\s+Bill\b|\bStudent\s+Veterans\s+of\s+America\b|\bactive[- ]duty\b|\bDD-?214\b|\bhonorabl[ey]\s+discharged?\b|\bservice\s?members?\b|\bmilitary\s+(?:service|spouse|family|child|children|dependents?|veteran|experience|member|connected|brat|kid)\b|\bNational\s+Guard\b|\bCoast\s+Guard\b|\bMarine\s+Corps\b|\bU\.?S\.?\s+(?:Army|Navy|Air\s+Force|Marines?|Space\s+Force|Coast\s+Guard)\b|\bAir\s+Force\b|\bSpace\s+Force\b|\bYellow\s+Ribbon\b|\bPost-9\/11\b|\bVA\s+(?:benefits|education)\b|\breservists?\b|\b(?:served|serving|serve|enlisted|stationed)\s+(?:in|with)\s+the\s+(?:navy|army|marines|marine\s+corps|air\s+force|coast\s+guard|military|national\s+guard)\b/i),
  rule("vet-military", "veteran", "contextual", /\bmilitary\b/i, { excludes: [/\bmilitary[- ]grade\b/i, /\bmilitary\s+(?:time|history)\b/i] }),
  rule("vet-acronyms", "veteran", "contextual", /\bUSMC\b|\bUSAF\b|\bUSN\b|\bUSCG\b|\bUSAR\b|\b(?:J|N|AF)?ROTC\b/),
  rule("vet-army", "veteran", "contextual", /\bArmy\b/, { excludes: [/\bSalvation\s+Army\b/i, /\bArmy\s+of\s+(?:volunteers|students|one|ants)\b/i, /\bSwiss\s+Army\b/i] }),
  rule("vet-navy", "veteran", "contextual", /\bNavy\b/, { excludes: [/\bOld\s+Navy\b/i, /\bNavy[- ](?:blue|colou?r(?:ed)?|themed?)\b/i, /\bNavy\s+Pier\b/i] }),
  rule("vet-marines", "veteran", "contextual", /\bMarines\b|\bMarine\s+(?:veteran|reservist|infantry|recruit|rifleman|riflemen|sergeant|corporal|officer|aviator)\b|(?:\b[Ee]x-|\b[Ff]ormer\s+|\b[Rr]etired\s+|\bas\s+a\s+|\bproud\s+|\bU\.?S\.?\s+)Marine\b/, {
    excludes: [/\bMarine\s+(?:Biology|Biological|Science|Sciences|Ecology|Conservation|Lab(?:oratory)?|Institute|Mammals?|Life|Engineering|Policy|Sanctuary|Center|Research|Studies)\b/i],
  }),
  rule("vet-roles", "veteran", "definite", /\bsoldiers?\b|\bcorpsm[ae]n\b|\bcombat\s+(?:medic|engineer|veteran|deployment|tour)s?\b|\binfantry(?:man|men)?\b|\bparatroopers?\b|\briflem[ae]n\b|\bAirborne\s+(?:Division|Brigade|Regiment|Infantry|School|Ranger)\b|\b\d+(?:st|nd|rd|th)\s+(?:Airborne|Infantry|Cavalry|Armored|Marine|Ranger)\b|\bRangers?\s+(?:Regiment|Battalion|School|qualified|tab)\b|\bboot\s+camp\b(?=[^\n]{0,40}\b(?:Army|Navy|Marines?|Air\s+Force|Guard|military|Parris|Lackland|Fort)\b)/i, {
    excludes: [/\bsoldier[\s-]+(?:fly|flies|ants?|crabs?|beetles?)\b/i, /\b(?:toy|tin)\s+soldiers?\b/i, /\bCounter[- ]Strike\b/i],
  }),
  rule("vet-served-years", "veteran", "contextual", /\bserved\s+(?:for\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|several)\s+years?\b/i, {
    requires: /\b(?:military|Army|Navy|Marines?|Air\s+Force|Guard|active\s+duty|enlist\w*|overseas|deploy\w*|infantry|rifleman|combat|battalion|squad|platoon|brigade|tours?|service\s+members?|USMC|USAF|reserves?)\b/i,
  }),
  rule("vet-ranks", "veteran", "contextual", /\b(?:Sergeant|Sgt\.|Corporal|Cpl\.|Lance\s+Corporal|Private\s+First\s+Class|PFC|Petty\s+Officer|Staff\s+Sergeant|Airman|Seaman)\b/, {
    excludes: [/\bSergeant[- ]at[- ]Arms\b/i],
  }),
  rule("vet-academies", "veteran", "contextual", /\bWest\s+Point\b|\b(?:Naval|Air\s+Force|Coast\s+Guard|Merchant\s+Marine)\s+Academy\b|\bCivil\s+Air\s+Patrol\b|\bSea\s+Cadets?\b|\bYoung\s+Marines\b/i),
  rule("vet-deployed", "veteran", "contextual", /\bdeploy(?:ed|ment|ments)\b|\benlist(?:ed|ment)\b/i, {
    requires: /\b(?:Army|Navy|Marines?|Air\s+Force|military|troops?|overseas|combat|battalion|brigade|squadron|regiment|Afghanistan|Iraq|Kuwait|Guard|platoon|soldiers?)\b/i,
  }),

  // ---------------------------------------------------------------- foster care
  rule("fos-terms", "foster_care", "definite", /\bfoster\s+(?:care|youth|child(?:ren)?|kids?|home|homes|famil(?:y|ies)|parents?|system|students?|placements?)\b|\bformer\s+foster\b|\bward\s+of\s+the\s+(?:state|court)\b|\bGuardian\s+Scholars?\b|\baged\s+out\s+of\b|\bChafee\b|\bkinship\s+(?:care|caregivers?)\b|\bgroup\s+homes?\b|\bemancipated\s+(?:minor|youth)\b|\bindependent\s+living\s+program\b/i, {
    excludes: [
      /\bfoster\w*\s+(?:dogs?|cats?|kittens?|puppies|animals?|pets?)\b/i,
      /\b(?:dog|cat|kitten|puppy|animal|pet)\s+foster\w*/i,
      /\bfoster\s+homes?\s+for\s+(?:\w+\s+)?(?:dogs?|cats?|kittens?|puppies|animals?|pets?)\b/i,
    ],
  }),
  rule("fos-casa", "foster_care", "contextual", /\bCASA\b/),
  rule("fos-casa-words", "foster_care", "contextual", /\bcourt[- ]appointed\s+special\s+advocates?\b/i),

  // ---------------------------------------------------------------- health
  rule("hea-terms", "health", "definite", /\bcancer\s+survivor\b|\bsurvived\s+cancer\b|\bdiagnosed\s+with\b|\bdiagnosis\s+of\b|\bchronic\s+(?:illness|disease|condition|fatigue|migraines?)\b|\bdiabet(?:es|ic)\b|\bdepression\b|\banxiety\b|\bpanic\s+(?:disorder|attacks?)\b|\bmental\s+(?:health|illness)\b|\beating\s+disorders?\b|\banorexia\b|\bbulimia\b|\bbipolar\b|\bschizophreni\w*|\bsuicid\w*|\bself[- ]harm\b|\bmedical\s+(?:leave|withdrawal|condition|hardship)\b|\bleave\s+of\s+absence\b|\bhospitali[sz](?:ed|ation)\b|\bpregnan(?:t|cy)\b|\bepilep(?:sy|tic)\b|\bseizures?\b|\bcystic\s+fibrosis\b|\bsickle\s+cell\b|\blupus\b|\bCrohn'?s\b|\bceliac\b|\basthma\b|\bcancer\b|\bchemotherapy\b|\bchemo\b|\btransplants?\b|\bconcussions?\b|\btraumatic\s+brain\s+injur(?:y|ies)\b|\baddiction\b|\bsobriety\b|\bsober\b|\brecovery\s+(?:community|program|from)\b|\bsubstance\s+(?:use|abuse)\b|\bmy\s+(?:illness|condition|diagnosis|treatment|recovery)\b|\bimmunocompromised\b|\bterminal\s+illness\b|\bdialysis\b|\blong\s+COVID\b/i, {
    research: true,
    excludes: [
      /\bGreat\s+Depression\b/i,
      /\bdepression[- ]era\b/i,
      /\beconomic\s+depression\b/i,
      /\bdiagnos\w*\s+of\s+(?:network|hardware|software|system|engine|vehicle|computer|device)\w*/i,
    ],
  }),
  rule("hea-recovery", "health", "definite", /\bin\s+recovery\b|\b(?:12|twelve)[- ]step\b|\bAl-?Anon\b|\bAlateen\b|\bAlcoholics\s+Anonymous\b|\bNarcotics\s+Anonymous\b/i),
  rule("hea-aa-na", "health", "contextual", /\bAA\b|\bNA\b/, { requires: /\b(?:sponsor\w*|meetings?|recovery|sober\w*|addiction|alcohol\w*|substance|12-step|chip|support\s+group)\b/i }),
  rule("hea-sponsor", "health", "contextual", /\bsponsor\b/i, { requires: /\b(?:recovery|sober\w*|AA|NA|12-step|addiction)\b/i }),
  rule("hea-acronyms", "health", "definite", /\bHIV\b|\bAIDS\b|\bPTSD\b|\bOCD\b|\bTBI\b/, { research: true }),

  // ---------------------------------------------------------------- parenting
  rule("par-terms", "parenting", "definite", /\bstudent[- ]parents?\b|\bparenting\s+students?\b|\bsingle\s+(?:mother|father|mom|dad|parent)\b|\b(?:mother|father|mom|dad|parent)\s+of\s+(?:a|an|one|two|three|four|five|\d+)\b|\bmy\s+(?:son|daughter|child|children|kids|baby|toddler|twins)\b|\bteen\s+(?:mom|mother|parent|dad|father)\b|\bexpecting\s+(?:a\s+)?(?:baby|child)\b|\bprimary\s+caregiver\b|\b(?:maternity|paternity|parental)\s+leave\b|\bchildcare\s+for\s+my\b/i),

  // ---------------------------------------------------------------- crime victims
  rule("cv-survivor", "crime_victim", "definite", /\b(?:survivor|victim)s?\s+of\s+(?:an?\s+|the\s+)?(?:domestic\s+violence|sexual\s+(?:assault|violence|abuse|harassment)|abuse|assault|(?:human\s+)?trafficking|crime|violent\s+crime|gun\s+violence|stalking|hate\s+crimes?)\b|\b(?:domestic\s+violence|sexual\s+assault|trafficking|abuse|assault)\s+survivors?\b/i),
  rule("cv-topics", "crime_victim", "contextual", /\bdomestic\s+violence\b|\bsexual\s+(?:assault|abuse|violence)\b|\bhuman\s+trafficking\b|\bintimate\s+partner\s+violence\b|\bchild\s+abuse\b/i),
];

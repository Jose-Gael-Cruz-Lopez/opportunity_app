import type { NowInput } from "../dates";
import {
  answerQuiz,
  applyResumeSignals,
  createQuizState,
  nextQuestion,
  skipQuestion,
  toPreferences,
  type AnswerValue,
  type QuestionId,
  type QuizState,
} from "../quiz";
import type { SignalsInput, StudentPreferences } from "../types";
import type { ResumeSource } from "../vocab";

/**
 * SAMPLE PERSONAS. Eight synthetic first- and second-year students for the offline evaluation.
 * Each is a short story, the answers that story implies, the PII-free resume signals (when the
 * student has a resume) and the sample program a careful advisor would put in front of them.
 * The expected programs were chosen from the story before the matcher was run; the evaluation
 * is a regression check on the pipeline, not a claim about real students.
 */

export interface SamplePersona {
  readonly id: string;
  readonly label: string;
  readonly story: string;
  readonly resume: ResumeSource;
  readonly signals: SignalsInput | null;
  /** Answers by question; pairs list the side the student would pick if asked. Unlisted questions are skipped. */
  readonly answers: Partial<Record<QuestionId, AnswerValue>>;
  readonly expectedSlug: string;
}

export const SAMPLE_PERSONAS: readonly SamplePersona[] = [
  {
    id: "maya",
    label: "Sample persona: first-year in computing",
    story: "Maya is a first-year computer science student who built a class project analysing bike-share data. She needs a paid summer role and has about three hours a week for applications.",
    resume: "pdf",
    signals: { skills: ["Python", "SQL", "Data analysis", "Tableau"], fields: ["computing"], graduationYear: 2030, experienceTypes: ["project"] },
    answers: {
      looking_for: ["internships", "research"],
      interests: ["ai_data", "software"],
      pair_style: "build",
      pair_length: "long",
      pair_value: "experience",
      timing: ["next_summer"],
      location: "nearby",
      pay: "must",
      weekly_hours: 3,
      goal: "first_yes",
    },
    expectedSlug: "sample-civic-data-internship",
  },
  {
    id: "jordan",
    label: "Sample persona: second-year in biology",
    story: "Jordan is a second-year biology major who worked in a teaching lab and wants a first real research summer.",
    resume: "pdf",
    signals: { skills: ["Cell culture", "Statistics", "Microsoft Excel"], fields: ["life_sciences"], graduationYear: 2029, experienceTypes: ["research", "volunteer"] },
    answers: {
      looking_for: ["research"],
      interests: ["health", "lab_science"],
      pair_style: "investigate",
      pair_length: "long",
      pair_value: "experience",
      timing: ["next_summer"],
      location: "travel",
      pay: "prefer",
      weekly_hours: 5,
      goal: "explore",
    },
    expectedSlug: "sample-biomedical-research-program",
  },
  {
    id: "priya",
    label: "Sample persona: first-year in business, no resume yet",
    story: "Priya is a first-year business student curious about finance and startups. She has no resume yet but used Excel in a club budget.",
    resume: "none",
    signals: null,
    answers: {
      looking_for: ["insight_weeks", "sprints"],
      interests: ["business", "startups"],
      skills: ["excel"],
      class_year: "first_year",
      major: "business",
      pair_style: "build",
      pair_length: "short",
      pair_value: "experience",
      timing: ["winter_break", "next_summer"],
      location: "travel",
      pay: "any",
      weekly_hours: 3,
      experience: ["leadership"],
      goal: "first_yes",
    },
    expectedSlug: "sample-finance-discovery-week",
  },
  {
    id: "sam",
    label: "Sample persona: undeclared first-year looking for funding",
    story: "Sam has not declared a major, volunteers with a campus climate group and mainly needs money for school.",
    resume: "none",
    signals: null,
    answers: {
      looking_for: ["scholarships", "fellowships"],
      interests: ["climate", "social_impact"],
      class_year: "first_year",
      major: "undeclared",
      pair_style: "investigate",
      pair_length: "long",
      pair_value: "funding",
      timing: ["anytime"],
      location: "nearby",
      pay: "any",
      weekly_hours: 2,
      experience: ["community_service"],
      goal: "funding",
    },
    expectedSlug: "sample-climate-leaders-scholarship",
  },
  {
    id: "alex",
    label: "Sample persona: second-year in engineering",
    story: "Alex is a second-year engineering student on the rocketry club who uses SolidWorks, MATLAB and Arduino and needs a paid summer internship.",
    resume: "docx",
    signals: { skills: ["SolidWorks", "MATLAB", "Arduino"], fields: ["Engineering and technology"], graduationYear: 2029, experienceTypes: ["competition", "club"] },
    answers: {
      looking_for: ["internships"],
      interests: ["space", "hardware"],
      pair_style: "build",
      pair_length: "long",
      pair_value: "experience",
      timing: ["next_summer"],
      location: "travel",
      pay: "must",
      weekly_hours: 4,
      goal: "first_yes",
    },
    expectedSlug: "sample-rocketry-systems-internship",
  },
  {
    id: "taylor",
    label: "Sample persona: first-year in art and design",
    story: "Taylor is a first-year design student who edits short videos and makes posters, and wants something to enter this year.",
    resume: "paste",
    signals: { skills: ["Premiere Pro", "Photoshop"], fields: ["arts_design"], graduationYear: 2030, experienceTypes: ["project"] },
    answers: {
      looking_for: ["conferences"],
      interests: ["arts_media"],
      pair_style: "build",
      pair_length: "short",
      pair_value: "experience",
      timing: ["anytime"],
      location: "nearby",
      pay: "any",
      weekly_hours: 3,
      goal: "explore",
    },
    expectedSlug: "sample-student-film-design-challenge",
  },
  {
    id: "chris",
    label: "Sample persona: second-year in political science",
    story: "Chris is a second-year political science major on the debate team who wants a policy fellowship and already has one organization in mind.",
    resume: "pdf",
    signals: { skills: ["Writing", "Literature review", "Debate"], fields: ["social_sciences"], graduationYear: 2029, experienceTypes: ["leadership", "research"] },
    answers: {
      looking_for: ["fellowships"],
      interests: ["policy", "social_impact"],
      pair_style: "investigate",
      pair_length: "long",
      pair_value: "experience",
      timing: ["next_summer"],
      location: "travel",
      pay: "prefer",
      weekly_hours: 5,
      goal: "specific",
      target: "Meridian Policy",
    },
    expectedSlug: "sample-public-policy-fellows",
  },
  {
    id: "riley",
    label: "Sample persona: first-year who wants a remote apprenticeship",
    story: "Riley works part time, builds websites for friends and needs a paid, remote way into software.",
    resume: "paste",
    signals: { skills: ["JavaScript", "HTML", "CSS", "GitHub"], fields: ["computing"], graduationYear: 2030, experienceTypes: ["job"] },
    answers: {
      looking_for: ["apprenticeships"],
      interests: ["software"],
      pair_style: "build",
      pair_length: "long",
      pair_value: "experience",
      timing: ["anytime"],
      location: "remote",
      pay: "must",
      weekly_hours: 6,
      goal: "first_yes",
    },
    expectedSlug: "sample-software-apprenticeship",
  },
];

export interface PersonaRun {
  readonly state: QuizState;
  readonly preferences: StudentPreferences;
  /** Question ids in the order they were shown. */
  readonly asked: readonly QuestionId[];
  readonly confirmed: readonly QuestionId[];
}

/**
 * Plays a persona through the real quiz: resume signals first (as the resume step would),
 * then each question nextQuestion offers, accepting resume suggestions unless the persona
 * says otherwise, and skipping what the persona leaves blank.
 */
export function runPersona(persona: SamplePersona, opts: { now: NowInput; programs?: readonly { opportunityTypes: readonly string[] }[] }): PersonaRun {
  let state = createQuizState({ now: opts.now, timeZone: "America/New_York", ...(opts.programs ? { programs: opts.programs } : {}) });
  const asked: QuestionId[] = [];
  const confirmed: QuestionId[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const next = nextQuestion(state);
    if (!next) break;
    const id = next.question.id;
    asked.push(id);
    if (id === "resume") {
      state = persona.signals ? applyResumeSignals(state, persona.signals, persona.resume) : answerQuiz(state, "resume", persona.resume);
      continue;
    }
    const own = persona.answers[id];
    if (own !== undefined) {
      state = answerQuiz(state, id, own);
    } else if (next.mode === "confirm" && next.suggested !== undefined) {
      confirmed.push(id);
      state = answerQuiz(state, id, next.suggested);
    } else {
      state = skipQuestion(state, id);
    }
  }
  return { state, preferences: toPreferences(state), asked, confirmed };
}

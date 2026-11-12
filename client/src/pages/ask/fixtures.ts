import type { AskResponse } from "@shared/contracts";

/**
 * SAMPLE DATA for Ask Novus, used only when no Novus API answers. It shows what the page looks
 * like when the server has no Gemini key: a plain, deterministic search of Novus records with
 * citations. Programs are invented ("Sample ...") and link to example.org.
 */

export function sampleAskResponse(question: string, nowIso: string): AskResponse {
  const q = question.toLowerCase();
  const nomination = q.includes("nominat") || q.includes("campus");
  return {
    meta: {
      provider: "none",
      model: null,
      promptVersion: "sample",
      status: "unavailable",
      degradedReason: "no_api_key",
      generatedAt: nowIso,
      fallback: true,
    },
    answer: nomination
      ? "Some awards take applications only through your school. Your campus sets an earlier internal deadline, then nominates a few students [s1]. Check your campus deadline before the national one [s2]."
      : "Two sample programs in Novus match: the Sample Tech Insight Week closes first [s1], and the Sample Coastal Science Scholarship takes second-year students [s2].",
    answerType: "answered",
    citations: [
      {
        sourceId: "s1",
        kind: "novus_record",
        title: nomination ? "Sample Campus-Nominated Award: how to apply" : "Sample Tech Insight Week: dates",
        url: "https://example.org/sample-program-1",
        quote: nomination ? "Applicants must be nominated by their institution." : "Applications close in early December.",
      },
      {
        sourceId: "s2",
        kind: "program_page",
        title: nomination ? "Sample Campus-Nominated Award: campus deadlines" : "Sample Coastal Science Scholarship: eligibility",
        url: "https://example.org/sample-program-2",
        quote: nomination ? "Campus deadlines are set by each institution." : "Open to students in their second year of study.",
      },
    ],
    programRefs: nomination
      ? [{ slug: "sample-campus-nominated-award", name: "Sample Campus-Nominated Award" }]
      : [
          { slug: "sample-tech-insight-week", name: "Sample Tech Insight Week" },
          { slug: "sample-coastal-science-scholarship", name: "Sample Coastal Science Scholarship" },
        ],
    followUps: ["What do these programs ask for?", "Which of these are paid?"],
  };
}

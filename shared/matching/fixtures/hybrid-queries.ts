import type { LabeledQuery } from "../eval";
import { sampleCardBySlug } from "./sample-cards";

/**
 * SAMPLE, PROVISIONAL paraphrase queries over the fictional sample cards: how a student might
 * describe a program without using its words ("ocean science summer" for a coastal ecology REU).
 * Written and labelled from the card texts before any eval run, and never fed into the alias
 * table. They stand in for the real frozen test half (plan 6.5) in the lexical-vs-hybrid
 * comparison. Every query passes screenQueryForEmbedding (a test checks it).
 */
function q(id: string, query: string, slugs: readonly string[]): LabeledQuery {
  return { id, query, relevant: slugs.map((s) => sampleCardBySlug(s).programCycleId), source: "provisional" };
}

export const PARAPHRASE_QUERIES: readonly LabeledQuery[] = [
  q("h01", "ocean science summer", ["coastal-ecology-reu"]),
  q("h02", "wildlife fieldwork", ["coastal-ecology-reu"]),
  q("h03", "wall street exposure", ["summit-insight-week", "thames-markets-spring-week", "summit-markets-sprint", "summit-sophomore-analyst"]),
  q("h04", "coding job without college degree", ["keystone-software-apprenticeship"]),
  q("h05", "artificial intelligence research", ["lattice-ml-fellowship"]),
  q("h06", "public interest lawyer", ["northwind-law-externship"]),
  q("h07", "volunteer teaching rural", ["prairie-service-year"]),
  q("h08", "pre med clinical", ["beacon-health-pathways"]),
  q("h09", "gig work remote", ["pivot-micro-internships"]),
  q("h10", "github contributions", ["open-source-season"]),
  q("h11", "coding competition weekend", ["riverside-civic-hackathon"]),
  q("h12", "money for an independent project", ["cedar-undergraduate-research-grant"]),
  q("h13", "learn spanish overseas", ["lumen-language-fellowship"]),
  q("h14", "city government leadership", ["civic-leaders-fellowship"]),
  q("h15", "genetics careers", ["helix-biotech-discovery"]),
  q("h16", "physics lab summer", ["granite-surf-fellowship", "quartz-lab-summer-research"]),
  q("h17", "trading desk", ["summit-markets-sprint", "summit-technology-internship"]),
  q("h18", "represent a brand at school", ["atlas-campus-ambassador"]),
  q("h19", "attend a tech symposium", ["aurora-computing-travel-award"]),
  q("h20", "stock market workshop", ["summit-insight-week", "thames-markets-spring-week"]),
];

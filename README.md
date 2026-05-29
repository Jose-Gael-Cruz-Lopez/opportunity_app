# Novus

**The Career GPS for every student — not just the ones who already know where to look.**

Novus is a student career operating system: a verified opportunity database, per-program research hubs, multi-year career roadmaps, and a community intelligence layer that turns every accepted student into a resource for the next applicant. Built for every major, every year, every school — not just the students lucky enough to be in the right room.

## The problem

The best internships, scholarships, fellowships, and programs don't live on traditional job boards. They live in insider networks, org listservs, and word of mouth. Today's tools each fail in a specific way:

- **Handshake** is school-gated and skewed toward tech/business; less-connected schools see far fewer opportunities.
- **Symplicity** is built for career-center administrators, not students. Listings go stale and the student experience is an afterthought.
- **Simplify** and **JobRight** speed up *applying* and *scraping* — they don't solve discovery, curation, or guidance. The applicant pool gets noisier; individual applications get weaker.

Novus drags the hidden knowledge into the open and packages it so that every student — not just the ones already in the network — can find, prepare for, and win opportunities that move their career forward.

## What it does

Six product surfaces work together as a single student career OS:

1. **The Opportunity Universe** — A curated, human-verified, community-maintained database of student opportunities across every type and field: internships, scholarships, fellowships, REUs and research programs, leadership cohorts (MLT, SEO, and similar), competitions, government and nonprofit programs, and graduate-school pipelines. Tagged by major, year, GPA range, location, deadline, industry, and program type. Open to all — not school-gated.

2. **Opportunity Profile Pages** — The biggest differentiator. Every program gets its own research hub: program description and eligibility, official and crowdsourced timelines, acceptance-rate estimates, a curated bundle of YouTube videos, articles, and Reddit/Twitter threads, an alumni layer with LinkedIn links and coffee-chat requests, crowdsourced interview breakdowns, a "Did you get in?" outcome tracker, culture ratings, and smart deadline alerts with Google/Outlook sync.

3. **The Career Roadmap Engine** — A three-minute onboarding quiz produces a personalized, multi-year roadmap (freshman through senior). Each node is wired to real opportunities with real deadlines in the database. The roadmap updates dynamically as users hit milestones or pivot their goals — a living plan that democratizes what college counselors charge thousands for.

4. **The Readiness Score** — Before applying, each user sees a personalized "% ready" score per opportunity, built from their profile, crowdsourced data on who typically gets in, and the program's stated requirements. Gaps are listed explicitly with suggested next steps. Moves the student from reactive search to proactive preparation.

5. **The Community and Social Proof Engine** — Structured "I Got In!" stories from accepted students feed directly back into each profile page. Cohort groups, mentor matching with in-platform 15-minute scheduling, and verified badges turn every win into intel for the next applicant. This is the flywheel.

6. **The Daily Personalized Feed** — A daily-open surface for year-round retention: new opening alerts on tracked programs, fresh peer wins from the same school, video and article drops on saved opportunities, and community questions worth answering. A reason to return outside of recruiting season.

## Vision

Novus is not a job board. It is the first student career operating system — the tool a student uses from the day they start college to the day they graduate, that gets smarter the more they use it, and that turns every person who lands an opportunity into a resource for the next person trying to land the same one.

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS, shadcn/ui (Radix primitives), Wouter for routing, TanStack Query for data, Framer Motion / GSAP / Lenis for motion
- **Backend:** Express 5 on Node, TypeScript end-to-end via `tsx`
- **Data:** Drizzle ORM on SQLite (`better-sqlite3`) for local development
- **Auth:** Passport (local strategy) with `express-session`
- **Validation:** Zod across shared types and form resolvers
- **Build:** Vite for the client, `esbuild` for the server bundle

## Repository layout

```
client/   — React app (Vite)
server/   — Express API and SSR entrypoint
shared/   — Cross-boundary types and Zod schemas
script/   — Build and tooling scripts
```

## Local development

```bash
npm install
npm run dev        # start the dev server (server + client)
npm run db:push    # apply Drizzle schema changes locally
npm run check      # TypeScript check
npm run build      # production bundle
npm start          # run the production bundle
```

## Status

- Stage: idea to MVP
- Target launch: July / August 2026
- Launch strategy: hybrid marketing site with a curated set of deeply researched Opportunity Profile Pages, plus waitlist capture for the roadmap, readiness, and community surfaces

## Co-founded by

Jose Cruz-Lopez, Rori Olaniyi, Abby Bravo

import { useState, type FormEvent } from "react";
import { Send, Sparkles } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Panel } from "@/components/app";
import { appPaths } from "@/lib/routes";

const SUGGESTIONS = ["What can I apply to before winter break?", "Which programs need a letter?", "What should a second-year do this term?"] as const;

/**
 * The Ask box hands the question to the Ask page, which calls the assistant and shows sources.
 * Nothing is sent from Home, and the hint reminds students not to type status or identity
 * details (those questions are answered privately on each program page).
 */
export function AskBox({ className }: { className?: string }) {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 3) return;
    navigate(appPaths.askQuestion(q));
  };
  return (
    <Panel as="article" className={`grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[18px] gap-y-4 rounded-[28px] p-[22px] ${className ?? ""}`} aria-labelledby="ask-title">
      <span className="nv-orb" aria-hidden="true">
        <Sparkles className="h-5 w-5" fill="#fff" strokeWidth={0} />
      </span>
      <div>
        <h2 id="ask-title" className="nv-sec-title">
          Ask Novus
        </h2>
        <span className="nv-meta">Answers cite each program's own pages</span>
      </div>
      <form className="col-span-2 flex items-center gap-2" onSubmit={onSubmit}>
        <div className="nv-composer nv-field flex-1">
          <label htmlFor="home-ask" className="sr-only">
            Ask a question about programs
          </label>
          <input id="home-ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="What can I apply to before Dec 1?" autoComplete="off" maxLength={1000} aria-describedby="home-ask-hint" />
          <button type="submit" className="nv-round-go" aria-label="Ask" disabled={q.trim().length < 3}>
            <Send aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        </div>
      </form>
      <p id="home-ask-hint" className="col-span-2 -mt-2 nv-meta">
        Leave out citizenship, income or identity details; those checks happen privately on each program page.
      </p>
      <ul className="col-span-2 flex flex-wrap gap-2" aria-label="Suggested questions">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <Link href={appPaths.askQuestion(s)} className="nv-suggest inline-block">
              {s}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

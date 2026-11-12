import { Sprout } from "lucide-react";
import { Link } from "wouter";
import { Panel, ProgramArt, SampleTag, StatusTag } from "@/components/app";
import type { CardStatus } from "@/lib/deadlines";
import { appPaths } from "@/lib/routes";
import type { SeasonPick } from "./model";

/** "Picked for your season": one program on a stacked deck, with the reason it was picked. */
export function PickedCard({ pick, status, className }: { pick: SeasonPick | null; status: CardStatus | null; className?: string }) {
  return (
    <article className={`flex flex-col gap-3.5 ${className ?? ""}`} aria-labelledby="pick-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pick-title" className="nv-sec-title">
          Picked for your season
        </h2>
        <Link href={appPaths.explore} className="nv-link">
          See all
        </Link>
      </div>
      {pick && status ? (
        <>
          <div className="nv-deck">
            <div className="nv-deck-back" data-depth="2" aria-hidden="true" />
            <div className="nv-deck-back" data-depth="1" aria-hidden="true" />
            <Panel className="relative rounded-[32px] p-2.5">
              <ProgramArt types={pick.card.opportunityTypes} className="aspect-[6/5] max-h-[300px] w-full">
                <div className="absolute left-3 top-3 z-[1] flex max-w-[calc(100%-24px)] flex-col gap-1 rounded-[20px] bg-[rgba(var(--nv-shade),0.62)] px-4 py-3">
                  <b className="text-[22px] font-bold leading-tight tracking-[-.015em]">{pick.card.name}</b>
                  <span className="nv-meta">{pick.card.organizationName}</span>
                </div>
                <StatusTag status={status} className="bottom-3.5 right-3.5" />
                {pick.card.isSample ? <SampleTag className="bottom-3.5 left-3.5" /> : null}
              </ProgramArt>
            </Panel>
          </div>
          <p className="flex items-start gap-2.5 px-1.5 text-sm nv-ink-2">
            <Sprout aria-hidden="true" className="mt-px h-[18px] w-[18px] flex-none" style={{ color: "var(--nv-leaf)" }} />
            {pick.reason}
          </p>
          <Link href={appPaths.program(pick.card.slug)} className="nv-btn-go w-full">
            View program<span className="sr-only">: {pick.card.name}</span>
          </Link>
        </>
      ) : (
        <Panel className="flex flex-col items-start gap-3 rounded-[30px] p-6">
          <p className="nv-ink-2">Nothing new to suggest right now. Explore has every program checked so far.</p>
          <Link href={appPaths.explore} className="nv-btn">
            Explore programs
          </Link>
        </Panel>
      )}
    </article>
  );
}

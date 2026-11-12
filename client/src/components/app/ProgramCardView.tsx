import { Check, Star } from "lucide-react";
import { Link } from "wouter";
import type { ProgramCard } from "@shared/contracts/registry";
import { getOpportunityType } from "@shared/taxonomy";
import type { CardStatus } from "@/lib/deadlines";
import type { EligibilityHint } from "@/lib/eligibility-hint";
import { formatShortDate } from "@/lib/format";
import { appPaths } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { EligibilityChip, SampleTag, StatusTag } from "./chips";
import { Panel } from "./Panel";
import { ProgramArt } from "./ProgramArt";

export interface ProgramCardViewProps {
  card: ProgramCard;
  status: CardStatus;
  hint: EligibilityHint;
  whyShown: string;
  tracked: boolean;
  /** Omit to hide the Track button (signed-out views link to onboarding instead). */
  onToggleTrack?: () => void;
  trackBusy?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
}

/** Short type label for the art tag ("Research programs" -> first clause). */
export function typeLabel(card: Pick<ProgramCard, "opportunityTypes">): string {
  const def = card.opportunityTypes.map((t) => getOpportunityType(t)).find(Boolean);
  return def ? (def.label.split(/[(,]/)[0] ?? def.label).trim() : "Program";
}

/**
 * Explore card: status, type, name, organization, why-shown line, verification stamp,
 * eligibility chip and Track. The whole card is one link (stretched over the title) while the
 * Track button stays a separate control, so keyboard users get two clear stops per card.
 */
export function ProgramCardView({ card, status, hint, whyShown, tracked, onToggleTrack, trackBusy, headingLevel = 3, className }: ProgramCardViewProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const verifiedOn = card.verification.verifiedOn;
  return (
    <Panel as="article" className={cn("nv-pcard", className)}>
      <ProgramArt types={card.opportunityTypes} className="nv-pcard-art">
        <StatusTag status={status} className="left-3 top-3" />
        <span className="nv-tag nv-tag-light bottom-3 left-3">{typeLabel(card)}</span>
        {card.isSample ? <SampleTag className="right-3 top-3" /> : null}
      </ProgramArt>
      <div className="flex flex-1 flex-col gap-1.5 px-2.5 pb-1.5 pt-3.5">
        <Heading className="text-[18.5px] font-semibold leading-tight">
          <Link href={appPaths.program(card.slug)}>{card.name}</Link>
        </Heading>
        <span className="nv-meta truncate">{card.organizationName}</span>
        {whyShown ? <p className="text-sm leading-snug nv-ink-2">{whyShown}</p> : null}
        {verifiedOn && card.verification.state === "verified" ? (
          <span className="nv-meta mt-1.5 flex items-center gap-1.5">
            <Check aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.2} style={{ color: "var(--nv-good)" }} />
            Checked by a person {formatShortDate(verifiedOn)}
          </span>
        ) : (
          <span className="nv-meta mt-1.5">Not yet re-checked this cycle</span>
        )}
        <div className="nv-above mt-auto flex items-center gap-2.5 pt-3">
          <EligibilityChip hint={hint} />
          {onToggleTrack ? (
            <button
              type="button"
              className="nv-icon-btn ml-auto h-10 w-10"
              aria-pressed={tracked}
              aria-label={`${tracked ? "Stop tracking" : "Track"} ${card.name}`}
              onClick={onToggleTrack}
              disabled={trackBusy}
            >
              <Star aria-hidden="true" className="h-[18px] w-[18px]" fill={tracked ? "currentColor" : "none"} strokeWidth={1.6} />
            </button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

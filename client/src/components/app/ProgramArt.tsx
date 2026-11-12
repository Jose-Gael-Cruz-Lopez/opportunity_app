import type { ReactNode } from "react";
import { getOpportunityType, type OpportunityGroup } from "@shared/taxonomy";
import { cn } from "@/lib/utils";

/**
 * Card art without photographs: the Novus glow tile, tinted per opportunity family, so the tile
 * becomes the visual system (design report, option C). Decorative only.
 */
export type ArtTint = "clay" | "sky" | "sage" | "lilac" | "rose";

const GROUP_TINT: Record<OpportunityGroup, ArtTint> = {
  internships: "clay",
  early_career: "rose",
  research: "sky",
  fellowships: "lilac",
  scholarships: "clay",
  apprenticeships_training: "sage",
  service_government: "sage",
  events_competitions: "rose",
  community_resources: "sky",
  other: "clay",
};

export function tintForTypes(types: readonly string[]): ArtTint {
  const group = types.map((t) => getOpportunityType(t)?.group).find(Boolean);
  return group ? GROUP_TINT[group] : "clay";
}

export function ProgramArt({ types, className, children }: { types: readonly string[]; className?: string; children?: ReactNode }) {
  const tint = tintForTypes(types);
  return (
    <div className={cn("nv-art nv-glowbg", className)} data-tint={tint === "clay" ? undefined : tint}>
      {children}
    </div>
  );
}

import { MapPin, Clock, Building2, Briefcase, Users, Bookmark, ExternalLink, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Opportunity } from "@shared/schema";

interface OpportunityCardProps {
  opportunity: typeof import("@/lib/constants").MOCK_OPPORTUNITIES[number];
  onView?: () => void;
}

/* Pathful landing palette — orange, gold, green, teal, pink (no blue accents) */
const categoryColors: Record<string, string> = {
  internship: "bg-[#ff6b35]/12 text-[#ff6b35]",
  scholarship: "bg-[#00b351]/12 text-[#00a347] dark:text-[#00b351]",
  research: "bg-[#2dd4bf]/15 text-[#0d9488] dark:text-[#5eead4]",
  fellowship: "bg-[#f780d4]/15 text-[#d946a8] dark:text-[#f780d4]",
  competition: "bg-[#fdcb40]/25 text-[#b8860b] dark:text-[#c9a227]",
};

const orgColors: Record<string, string> = {
  Google: "bg-[#ff6b35]",
  "Goldman Sachs": "bg-[#1a3a5c]",
  "Bill & Melinda Gates Foundation": "bg-[#fdcb40] text-[#1a1a2e]",
  NASA: "bg-[#ff6b35]",
  "MIT Media Lab": "bg-[#00b351]",
  "Rhodes Trust": "bg-[#1a3a5c]",
  MIT: "bg-[#a31f34]",
  Apple: "bg-[#1a1a2e] dark:bg-[#f5f5f5] dark:text-[#1a1a2e]",
};

export function OpportunityCard({ opportunity, onView }: OpportunityCardProps) {
  const tags = opportunity.tags ? JSON.parse(opportunity.tags) as string[] : [];
  const daysUntilDeadline = opportunity.deadline
    ? Math.ceil((new Date(opportunity.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div
      className="group relative p-6 md:p-7 rounded-[1.5rem] border border-[#1a3a5c]/8 dark:border-border bg-white dark:bg-card hover:border-[#1a3a5c]/15 dark:hover:border-border hover:shadow-[0_12px_40px_rgba(0,0,0,0.08)] transition-all duration-300"
      style={{ boxShadow: "0 8px 30px rgba(0,0,0,0.06)" }}
      data-testid={`card-opportunity-${opportunity.id}`}
    >
      {/* Top badges row */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {daysUntilDeadline !== null && daysUntilDeadline <= 14 && (
          <Badge variant="outline" className="text-xs border-[#fdcb40]/50 text-[#b8860b] dark:text-[#fdcb40] bg-[#fdcb40]/12 font-medium">
            <Clock className="w-3 h-3 mr-1" />
            {daysUntilDeadline > 0 ? `${daysUntilDeadline}d left` : "Expired"}
          </Badge>
        )}
        {opportunity.matchScore && opportunity.matchScore >= 85 && (
          <Badge variant="outline" className="text-xs border-[#00b351]/40 text-[#00b351] bg-[#00b351]/10 font-medium">
            <Sparkles className="w-3 h-3 mr-1" />
            {opportunity.matchScore}% Match
          </Badge>
        )}
        {opportunity.isFeatured && (
          <Badge variant="outline" className="text-xs border-[#fdcb40]/55 text-[#b45309] dark:text-[#fde047] bg-[#fdcb40]/15 font-medium">
            Featured
          </Badge>
        )}
      </div>

      {/* Org + Title */}
      <div className="flex items-start gap-3.5 mb-3">
        <div className={`flex-shrink-0 w-12 h-12 rounded-2xl ${orgColors[opportunity.organization] || "bg-[#57534e]"} flex items-center justify-center text-white text-sm font-bold shadow-sm`}>
          {opportunity.organization.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-bold text-[15px] md:text-base leading-snug mb-1 text-[#1a3a5c] dark:text-foreground group-hover:text-[#ff6b35] transition-colors">
            {opportunity.title}
          </h3>
          <p className="text-xs text-[#5a6a7a] dark:text-muted-foreground">
            {opportunity.organization}
            <span className="mx-1.5 opacity-40">·</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold ${categoryColors[opportunity.category] || ""}`}>
              {opportunity.category.charAt(0).toUpperCase() + opportunity.category.slice(1)}
            </span>
          </p>
        </div>
      </div>

      {/* Details row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 text-xs text-[#5a6a7a] dark:text-muted-foreground">
        {opportunity.location && (
          <span className="flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            {opportunity.location}
          </span>
        )}
        {opportunity.locationType && (
          <span className="flex items-center gap-1">
            <Building2 className="w-3 h-3" />
            {opportunity.locationType.charAt(0).toUpperCase() + opportunity.locationType.slice(1)}
          </span>
        )}
        {opportunity.salary && (
          <span className="flex items-center gap-1 font-semibold text-[#1a3a5c] dark:text-foreground">
            <Briefcase className="w-3 h-3" />
            {opportunity.salary}
          </span>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {tags.map((tag) => (
            <span key={tag} className="px-2.5 py-0.5 rounded-full bg-[#f8f5f0] dark:bg-muted text-[11px] text-[#5a6a7a] dark:text-muted-foreground border border-[#1a3a5c]/6 dark:border-border">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Bottom row */}
      <div className="flex items-center justify-between pt-4 border-t border-[#1a3a5c]/8 dark:border-border">
        <span className="text-xs text-[#5a6a7a] dark:text-muted-foreground flex items-center gap-1">
          <Users className="w-3 h-3" />
          {opportunity.applicantCount ? `${opportunity.applicantCount} applicants` : "Be first to apply"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0 rounded-full text-[#1a3a5c]/60 hover:text-[#ff6b35] hover:bg-[#ff6b35]/10"
            data-testid={`button-save-${opportunity.id}`}
          >
            <Bookmark className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            className="h-9 rounded-full px-5 text-xs font-semibold bg-[#ff6b35] text-white hover:bg-[#ff6b35]/92 shadow-[0_6px_20px_rgba(255,107,53,0.28)] font-display"
            onClick={onView}
            data-testid={`button-apply-${opportunity.id}`}
          >
            View Details
            <ExternalLink className="w-3 h-3 ml-1.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

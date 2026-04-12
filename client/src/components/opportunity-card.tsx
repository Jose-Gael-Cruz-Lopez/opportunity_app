import { MapPin, Clock, Building2, Briefcase, Users, Bookmark, ExternalLink, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Opportunity } from "@shared/schema";

interface OpportunityCardProps {
  opportunity: typeof import("@/lib/constants").MOCK_OPPORTUNITIES[number];
  onView?: () => void;
}

const categoryColors: Record<string, string> = {
  internship: "bg-[hsl(var(--pathful-accent)/0.18)] text-[hsl(var(--pathful-accent))]",
  scholarship: "bg-[hsl(var(--pathful-green)/0.18)] text-[hsl(var(--pathful-green))]",
  research: "bg-[hsl(var(--pathful-blue)/0.2)] text-[hsl(var(--pathful-blue))]",
  fellowship: "bg-[hsl(var(--pathful-rose)/0.16)] text-[hsl(var(--pathful-rose))]",
  competition: "bg-[hsl(var(--pathful-gold)/0.22)] text-[hsl(var(--pathful-gold))]",
};

const orgColors: Record<string, string> = {
  Google: "bg-blue-600",
  "Goldman Sachs": "bg-blue-800",
  "Bill & Melinda Gates Foundation": "bg-amber-600",
  NASA: "bg-red-600",
  "MIT Media Lab": "bg-gray-800",
  "Rhodes Trust": "bg-blue-900",
  MIT: "bg-red-700",
  Apple: "bg-gray-900 dark:bg-gray-100",
};

export function OpportunityCard({ opportunity, onView }: OpportunityCardProps) {
  const tags = opportunity.tags ? JSON.parse(opportunity.tags) as string[] : [];
  const daysUntilDeadline = opportunity.deadline
    ? Math.ceil((new Date(opportunity.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div
      className="group relative p-5 rounded-xl border border-[hsl(var(--pathful-blue)/0.2)] bg-gradient-to-b from-[hsl(var(--pathful-navy-deep)/0.35)] to-card hover:border-[hsl(var(--pathful-blue)/0.4)] hover:shadow-lg transition-all"
      data-testid={`card-opportunity-${opportunity.id}`}
    >
      {/* Top badges row */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {daysUntilDeadline !== null && daysUntilDeadline <= 14 && (
          <Badge variant="outline" className="text-xs border-[hsl(var(--pathful-gold)/0.5)] text-[hsl(var(--pathful-gold))] bg-[hsl(var(--pathful-gold)/0.12)]">
            <Clock className="w-3 h-3 mr-1" />
            {daysUntilDeadline > 0 ? `${daysUntilDeadline}d left` : "Expired"}
          </Badge>
        )}
        {opportunity.matchScore && opportunity.matchScore >= 85 && (
          <Badge variant="outline" className="text-xs border-[hsl(var(--pathful-green)/0.5)] text-[hsl(var(--pathful-green))] bg-[hsl(var(--pathful-green)/0.12)]">
            <Sparkles className="w-3 h-3 mr-1" />
            {opportunity.matchScore}% Match
          </Badge>
        )}
        {opportunity.isFeatured && (
          <Badge variant="outline" className="text-xs border-[hsl(var(--pathful-blue)/0.35)] text-[hsl(var(--pathful-blue))] bg-[hsl(var(--pathful-blue)/0.12)]">
            Featured
          </Badge>
        )}
      </div>

      {/* Org + Title */}
      <div className="flex items-start gap-3.5 mb-3">
        <div className={`flex-shrink-0 w-11 h-11 rounded-lg ${orgColors[opportunity.organization] || "bg-primary"} flex items-center justify-center text-white text-xs font-bold`}>
          {opportunity.organization.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm leading-snug mb-0.5 group-hover:text-primary transition-colors">
            {opportunity.title}
          </h3>
          <p className="text-xs text-muted-foreground">
            {opportunity.organization}
            <span className="mx-1.5 opacity-40">·</span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${categoryColors[opportunity.category] || ""}`}>
              {opportunity.category.charAt(0).toUpperCase() + opportunity.category.slice(1)}
            </span>
          </p>
        </div>
      </div>

      {/* Details row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 text-xs text-muted-foreground">
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
          <span className="flex items-center gap-1 font-medium text-foreground">
            <Briefcase className="w-3 h-3" />
            {opportunity.salary}
          </span>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {tags.map((tag) => (
            <span key={tag} className="px-2 py-0.5 rounded-full bg-muted text-[11px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Bottom row */}
      <div className="flex items-center justify-between pt-3 border-t border-border/40">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Users className="w-3 h-3" />
          {opportunity.applicantCount ? `${opportunity.applicantCount} applicants` : "Be first to apply"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            data-testid={`button-save-${opportunity.id}`}
          >
            <Bookmark className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-full px-4 text-xs font-semibold bg-[hsl(var(--pathful-blue))] text-white hover:bg-[hsl(var(--pathful-blue)/0.9)]"
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

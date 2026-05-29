import { useRoute, Link } from "wouter";
import { MOCK_OPPORTUNITIES, MOCK_STORIES } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, MapPin, Building2, Clock, Briefcase, Users,
  Bookmark, ExternalLink, Sparkles, CheckCircle2, FileText,
  BookOpen, Video, Quote, Calendar, DollarSign
} from "lucide-react";

const RESOURCES = [
  { title: "Application Guide", type: "PDF", icon: <FileText className="w-4 h-4" /> },
  { title: "Interview Prep Kit", type: "Guide", icon: <BookOpen className="w-4 h-4" /> },
  { title: "Day in the Life Video", type: "Video", icon: <Video className="w-4 h-4" /> },
];

export default function OpportunityProfilePage() {
  const [, params] = useRoute("/opportunity/:id");
  const id = params?.id ? parseInt(params.id) : 1;
  const opportunity = MOCK_OPPORTUNITIES.find((o) => o.id === id) || MOCK_OPPORTUNITIES[0];
  const relatedStory = MOCK_STORIES.find((s) => s.category === "got-in");
  const tags = opportunity.tags ? JSON.parse(opportunity.tags) as string[] : [];

  return (
    <div className="h-full overflow-auto" data-testid="page-opportunity-profile">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {/* Back button */}
        <Link href="/dashboard">
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 cursor-pointer">
            <ArrowLeft className="w-4 h-4" />
            Back to Opportunities
          </span>
        </Link>

        {/* Header card */}
        <div className="p-6 rounded-2xl bg-card border border-border/50 mb-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-14 h-14 rounded-xl bg-primary flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
              {opportunity.organization.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="font-display font-bold text-lg mb-1">{opportunity.title}</h1>
              <p className="text-sm text-muted-foreground">{opportunity.organization}</p>
            </div>
          </div>

          {/* Match score + badges */}
          <div className="flex flex-wrap gap-2 mb-5">
            {opportunity.matchScore && opportunity.matchScore >= 80 && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                <Sparkles className="w-3 h-3 mr-1" />
                {opportunity.matchScore}% Match
              </Badge>
            )}
            <Badge variant="outline">
              {opportunity.category.charAt(0).toUpperCase() + opportunity.category.slice(1)}
            </Badge>
            {opportunity.isFeatured && (
              <Badge variant="outline" className="border-primary/30 text-primary">
                Featured
              </Badge>
            )}
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3 mb-5">
            {opportunity.location && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="w-4 h-4 flex-shrink-0" />
                <span>{opportunity.location}</span>
              </div>
            )}
            {opportunity.locationType && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Building2 className="w-4 h-4 flex-shrink-0" />
                <span>{opportunity.locationType.charAt(0).toUpperCase() + opportunity.locationType.slice(1)}</span>
              </div>
            )}
            {opportunity.salary && (
              <div className="flex items-center gap-2 text-sm font-medium">
                <DollarSign className="w-4 h-4 flex-shrink-0" />
                <span>{opportunity.salary}</span>
              </div>
            )}
            {opportunity.deadline && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="w-4 h-4 flex-shrink-0" />
                <span>Deadline: {new Date(opportunity.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-1.5 mb-5">
            {tags.map((tag) => (
              <span key={tag} className="px-2.5 py-1 rounded-full bg-muted text-xs text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button className="rounded-full px-6 flex-1 sm:flex-none" data-testid="button-apply">
              Apply Now
              <ExternalLink className="w-4 h-4 ml-2" />
            </Button>
            <Button variant="outline" className="rounded-full" data-testid="button-save-opportunity">
              <Bookmark className="w-4 h-4 mr-2" />
              Save
            </Button>
          </div>
        </div>

        {/* Description */}
        <div className="p-6 rounded-2xl bg-card border border-border/50 mb-6">
          <h2 className="font-display font-semibold text-sm mb-3">About This Opportunity</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {opportunity.description}
          </p>
          <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
            <Users className="w-3.5 h-3.5" />
            {opportunity.applicantCount || 0} students have applied
          </div>
        </div>

        {/* Readiness fit */}
        <div className="p-6 rounded-2xl bg-card border border-border/50 mb-6">
          <h2 className="font-display font-semibold text-sm mb-4">Your Readiness Fit</h2>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Technical Skills</span>
                <span className="font-medium text-primary">85%</span>
              </div>
              <Progress value={85} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Experience Level</span>
                <span className="font-medium text-amber-500">60%</span>
              </div>
              <Progress value={60} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Application Materials</span>
                <span className="font-medium text-emerald-500">90%</span>
              </div>
              <Progress value={90} className="h-2" />
            </div>
          </div>
          <Link href="/readiness">
            <span className="inline-flex items-center gap-1 text-xs text-primary mt-3 cursor-pointer hover:underline">
              View full readiness report <ArrowLeft className="w-3 h-3 rotate-180" />
            </span>
          </Link>
        </div>

        {/* Resource Bundle */}
        <div className="p-6 rounded-2xl bg-card border border-border/50 mb-6">
          <h2 className="font-display font-semibold text-sm mb-4">Resource Bundle</h2>
          <div className="space-y-2">
            {RESOURCES.map((res) => (
              <div
                key={res.title}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/30 hover:border-primary/20 transition-all cursor-pointer"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  {res.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{res.title}</div>
                  <div className="text-[11px] text-muted-foreground">{res.type}</div>
                </div>
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </div>
            ))}
          </div>
        </div>

        {/* Alumni story */}
        {relatedStory && (
          <div className="p-6 rounded-2xl bg-card border border-border/50 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <h2 className="font-display font-semibold text-sm">Student Who Got In</h2>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs flex-shrink-0">
                {relatedStory.authorName.split(" ").map((n) => n[0]).join("")}
              </div>
              <div>
                <div className="text-sm font-semibold">{relatedStory.authorName}</div>
                <div className="text-xs text-muted-foreground mb-2">{relatedStory.university}</div>
                <Quote className="w-5 h-5 text-primary/20 mb-1" />
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                  {relatedStory.content}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

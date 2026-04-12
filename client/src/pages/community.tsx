import { useState, useEffect, useRef } from "react";
import { MOCK_STORIES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Quote, Heart, MessageCircle, Share2, CheckCircle2,
  MapPin, Search, Filter, TrendingUp, Clock, Award
} from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const COMMUNITY_TABS = [
  { key: "all", label: "All Stories", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: "got-in", label: "I Got In!", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  { key: "advice", label: "Advice", icon: <Award className="w-3.5 h-3.5" /> },
  { key: "experience", label: "Experience", icon: <Clock className="w-3.5 h-3.5" /> },
];

const MENTORS = [
  { name: "Dr. Sarah Mitchell", role: "Engineering Mentor", university: "Stanford", expertise: "Software Engineering, AI/ML", available: true },
  { name: "Marcus Thompson", role: "Finance Mentor", university: "Wharton", expertise: "Investment Banking, FinTech", available: true },
  { name: "Priya Patel", role: "Research Mentor", university: "MIT", expertise: "Biotech, Research Methods", available: false },
  { name: "David Kim", role: "Career Advisor", university: "Harvard", expertise: "Consulting, Strategy", available: true },
];

export default function CommunityPage() {
  const [activeTab, setActiveTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [likedStories, setLikedStories] = useState<Set<number>>(new Set());
  const storiesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-community-card]").forEach((card, i) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: "top 90%",
            toggleActions: "play none none none",
          },
          y: 30,
          opacity: 0,
          duration: 0.5,
          ease: "power2.out",
          delay: i * 0.08,
        });
      });
    }, storiesRef);

    return () => ctx.revert();
  }, [activeTab]);

  const filteredStories = MOCK_STORIES.filter((story) => {
    if (activeTab !== "all" && story.category !== activeTab) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        story.title.toLowerCase().includes(q) ||
        story.authorName.toLowerCase().includes(q) ||
        story.content.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleLike = (id: number) => {
    setLikedStories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="h-full overflow-auto" data-testid="page-community">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display font-bold text-xl mb-1" data-testid="text-page-title">
            Community
          </h1>
          <p className="text-sm text-muted-foreground">
            Real stories from students who found their path
          </p>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-5 border-b border-border/50 overflow-x-auto">
          {COMMUNITY_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-community-${tab.key}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search stories, authors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-10 rounded-lg bg-muted/50"
            data-testid="input-search-community"
          />
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Stories column */}
          <div ref={storiesRef} className="lg:col-span-2 space-y-4">
            {filteredStories.map((story) => (
              <div
                key={story.id}
                data-community-card
                className="p-5 rounded-xl bg-card border border-border/50 hover:border-primary/20 transition-all"
                data-testid={`card-community-story-${story.id}`}
              >
                {/* Author */}
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                    {story.authorName.split(" ").map((n) => n[0]).join("")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">{story.authorName}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {story.university}
                    </div>
                  </div>
                  {story.category === "got-in" && (
                    <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 text-[10px] font-semibold">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Got In!
                    </Badge>
                  )}
                  {story.category === "advice" && (
                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 text-[10px] font-semibold">
                      <Award className="w-3 h-3 mr-1" />
                      Advice
                    </Badge>
                  )}
                </div>

                {/* Content */}
                <h3 className="font-semibold text-sm mb-2">{story.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  {story.content}
                </p>

                {story.opportunityTitle && (
                  <div className="px-3 py-2 rounded-lg bg-muted/50 border border-border/40 mb-4 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Opportunity:</span>{" "}
                    {story.opportunityTitle}
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-4 pt-3 border-t border-border/30">
                  <button
                    onClick={() => toggleLike(story.id)}
                    className={`flex items-center gap-1.5 text-xs transition-colors ${
                      likedStories.has(story.id)
                        ? "text-rose-500"
                        : "text-muted-foreground hover:text-rose-500"
                    }`}
                    data-testid={`button-like-${story.id}`}
                  >
                    <Heart className={`w-4 h-4 ${likedStories.has(story.id) ? "fill-current" : ""}`} />
                    {(story.likes || 0) + (likedStories.has(story.id) ? 1 : 0)}
                  </button>
                  <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    <MessageCircle className="w-4 h-4" />
                    Reply
                  </button>
                  <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    <Share2 className="w-4 h-4" />
                    Share
                  </button>
                </div>
              </div>
            ))}

            {filteredStories.length === 0 && (
              <div className="text-center py-16">
                <Quote className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                <h3 className="font-display font-semibold mb-1">No stories found</h3>
                <p className="text-sm text-muted-foreground">
                  Try a different search or category.
                </p>
              </div>
            )}
          </div>

          {/* Mentors sidebar */}
          <div className="space-y-4">
            <h3 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider">
              Featured Mentors
            </h3>
            {MENTORS.map((mentor) => (
              <div
                key={mentor.name}
                className="p-4 rounded-xl bg-card border border-border/50 hover:border-primary/20 transition-all"
                data-testid={`card-mentor-${mentor.name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">
                    {mentor.name.split(" ").map((n) => n[0]).join("")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{mentor.name}</div>
                    <div className="text-[11px] text-muted-foreground">{mentor.role}</div>
                  </div>
                  {mentor.available && (
                    <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-3">{mentor.expertise}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs rounded-lg"
                  disabled={!mentor.available}
                >
                  {mentor.available ? "Connect" : "Unavailable"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OpportunityCard } from "@/components/opportunity-card";
import { MOCK_OPPORTUNITIES, OPPORTUNITY_CATEGORIES } from "@/lib/constants";
import {
  Search, SlidersHorizontal, X, Sparkles,
  Clock, TrendingUp, Star
} from "lucide-react";

const LOCATION_TYPES = [
  { value: "all", label: "All Types" },
  { value: "onsite", label: "Onsite" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
];

const SORT_OPTIONS = [
  { value: "match", label: "Best Match" },
  { value: "deadline", label: "Deadline (Soonest)" },
  { value: "newest", label: "Newest First" },
];

const TABS = [
  { key: "recommended", label: "Recommended", icon: <Sparkles className="w-3.5 h-3.5" /> },
  { key: "saved", label: "Saved", icon: <Star className="w-3.5 h-3.5" />, count: 3 },
  { key: "applied", label: "Applied", icon: <Clock className="w-3.5 h-3.5" />, count: 1 },
  { key: "trending", label: "Trending", icon: <TrendingUp className="w-3.5 h-3.5" /> },
];

export default function DashboardPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [locationType, setLocationType] = useState("all");
  const [sortBy, setSortBy] = useState("match");
  const [activeTab, setActiveTab] = useState("recommended");
  const [showFilters, setShowFilters] = useState(false);

  const activeFilters = [
    category !== "all" ? category : null,
    locationType !== "all" ? locationType : null,
  ].filter(Boolean);

  const filteredOpportunities = useMemo(() => {
    let result = [...MOCK_OPPORTUNITIES];

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (opp) =>
          opp.title.toLowerCase().includes(q) ||
          opp.organization.toLowerCase().includes(q) ||
          opp.description?.toLowerCase().includes(q)
      );
    }

    // Filter by category
    if (category !== "all") {
      result = result.filter((opp) => opp.category === category);
    }

    // Filter by location type
    if (locationType !== "all") {
      result = result.filter((opp) => opp.locationType === locationType);
    }

    // Sort
    if (sortBy === "match") {
      result.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    } else if (sortBy === "deadline") {
      result.sort((a, b) => {
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
      });
    }

    return result;
  }, [searchQuery, category, locationType, sortBy]);

  const clearFilters = () => {
    setCategory("all");
    setLocationType("all");
    setSearchQuery("");
  };

  return (
    <div className="h-full overflow-auto" data-testid="page-dashboard">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="font-display font-bold text-xl mb-1" data-testid="text-page-title">
            Opportunities
          </h1>
          <p className="text-sm text-muted-foreground">
            Discover curated opportunities matched to your profile
          </p>
        </div>

        {/* Tabs — inspired by JobRight */}
        <div className="flex items-center gap-1 mb-5 border-b border-border/50 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-${tab.key}`}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-1 px-1.5 py-0.5 rounded-full text-xs font-semibold ${
                  activeTab === tab.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search + Filter Bar */}
        <div className="flex flex-col gap-3 mb-5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search opportunities, companies..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-10 rounded-lg bg-muted/50 border-border/50"
                data-testid="input-search"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className="h-10 px-3 rounded-lg gap-1.5"
              data-testid="button-filters"
            >
              <SlidersHorizontal className="w-4 h-4" />
              Filters
              {activeFilters.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                  {activeFilters.length}
                </span>
              )}
            </Button>
          </div>

          {/* Filter dropdowns — collapsible */}
          {showFilters && (
            <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border/40">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-[160px] h-9 text-xs" data-testid="select-category">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  {OPPORTUNITY_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={locationType} onValueChange={setLocationType}>
                <SelectTrigger className="w-[140px] h-9 text-xs" data-testid="select-location">
                  <SelectValue placeholder="Location Type" />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_TYPES.map((lt) => (
                    <SelectItem key={lt.value} value={lt.value}>{lt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[150px] h-9 text-xs" data-testid="select-sort">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {activeFilters.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-9 text-xs text-muted-foreground"
                >
                  Clear all
                </Button>
              )}
            </div>
          )}

          {/* Active filter badges */}
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {category !== "all" && (
                <Badge variant="secondary" className="text-xs gap-1 pr-1">
                  {OPPORTUNITY_CATEGORIES.find(c => c.value === category)?.label}
                  <button onClick={() => setCategory("all")} className="ml-0.5 hover:text-foreground">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              )}
              {locationType !== "all" && (
                <Badge variant="secondary" className="text-xs gap-1 pr-1">
                  {LOCATION_TYPES.find(l => l.value === locationType)?.label}
                  <button onClick={() => setLocationType("all")} className="ml-0.5 hover:text-foreground">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Results count */}
        <div className="text-xs text-muted-foreground mb-4">
          {filteredOpportunities.length} {filteredOpportunities.length === 1 ? "opportunity" : "opportunities"} found
        </div>

        {/* Opportunity Cards */}
        <div className="space-y-3">
          {filteredOpportunities.map((opp) => (
            <OpportunityCard key={opp.id} opportunity={opp} />
          ))}
        </div>

        {filteredOpportunities.length === 0 && (
          <div className="text-center py-16">
            <Search className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <h3 className="font-display font-semibold mb-1">No opportunities found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Try adjusting your filters or search query.
            </p>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear Filters
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

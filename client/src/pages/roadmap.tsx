import { useState, useEffect, useRef } from "react";
import { MOCK_MILESTONES } from "@/lib/constants";
import { CheckCircle2, Circle, GraduationCap, BookOpen, Briefcase, Users, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const YEARS = [
  { key: "freshman", label: "Freshman", color: "hsl(var(--pathful-gold))", bgLight: "hsl(40 85% 95%)", bgDark: "hsl(40 40% 15%)" },
  { key: "sophomore", label: "Sophomore", color: "hsl(var(--pathful-green))", bgLight: "hsl(155 50% 94%)", bgDark: "hsl(155 30% 14%)" },
  { key: "junior", label: "Junior", color: "hsl(var(--pathful-blue))", bgLight: "hsl(220 60% 95%)", bgDark: "hsl(220 35% 15%)" },
  { key: "senior", label: "Senior", color: "hsl(var(--pathful-rose))", bgLight: "hsl(340 55% 95%)", bgDark: "hsl(340 30% 15%)" },
] as const;

const categoryIcons: Record<string, React.ReactNode> = {
  academic: <BookOpen className="w-4 h-4" />,
  professional: <Briefcase className="w-4 h-4" />,
  extracurricular: <Users className="w-4 h-4" />,
};

export default function RoadmapPage() {
  const [activeYear, setActiveYear] = useState("freshman");
  const [completedItems, setCompletedItems] = useState<Record<string, boolean[]>>(() => {
    const initial: Record<string, boolean[]> = {};
    Object.entries(MOCK_MILESTONES).forEach(([year, milestones]) => {
      initial[year] = milestones.map((m) => m.isCompleted);
    });
    return initial;
  });

  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-milestone]").forEach((el, i) => {
        gsap.from(el, {
          scrollTrigger: {
            trigger: el,
            start: "top 90%",
            toggleActions: "play none none none",
          },
          x: -30,
          opacity: 0,
          duration: 0.5,
          ease: "power2.out",
          delay: i * 0.06,
        });
      });
    }, timelineRef);

    return () => ctx.revert();
  }, [activeYear]);

  const toggleComplete = (year: string, index: number) => {
    setCompletedItems((prev) => {
      const updated = { ...prev };
      updated[year] = [...updated[year]];
      updated[year][index] = !updated[year][index];
      return updated;
    });
  };

  const getProgress = (year: string) => {
    const items = completedItems[year];
    if (!items || items.length === 0) return 0;
    return Math.round((items.filter(Boolean).length / items.length) * 100);
  };

  const totalProgress = () => {
    const allItems = Object.values(completedItems).flat();
    if (allItems.length === 0) return 0;
    return Math.round((allItems.filter(Boolean).length / allItems.length) * 100);
  };

  const currentYear = YEARS.find((y) => y.key === activeYear)!;
  const milestones = MOCK_MILESTONES[activeYear as keyof typeof MOCK_MILESTONES] || [];

  return (
    <div className="h-full overflow-auto" data-testid="page-roadmap">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display font-bold text-xl mb-1" data-testid="text-page-title">
            Career Roadmap
          </h1>
          <p className="text-sm text-muted-foreground">
            Your personalized year-by-year career GPS
          </p>
        </div>

        {/* Overall progress */}
        <div className="p-5 rounded-xl bg-card border border-border/50 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Overall Progress</span>
            <span className="text-sm font-bold text-primary">{totalProgress()}%</span>
          </div>
          <Progress value={totalProgress()} className="h-2" />
          <p className="text-xs text-muted-foreground mt-2">
            {Object.values(completedItems).flat().filter(Boolean).length} of{" "}
            {Object.values(completedItems).flat().length} milestones completed
          </p>
        </div>

        {/* Year tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {YEARS.map((year) => {
            const progress = getProgress(year.key);
            const isActive = activeYear === year.key;
            return (
              <button
                key={year.key}
                onClick={() => setActiveYear(year.key)}
                className={`flex-shrink-0 flex items-center gap-2.5 px-4 py-3 rounded-xl border transition-all ${
                  isActive
                    ? "border-primary/40 bg-primary/5 shadow-sm"
                    : "border-border/50 bg-card hover:border-border"
                }`}
                data-testid={`tab-${year.key}`}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: year.color }}
                >
                  {year.label.charAt(0)}
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold">{year.label}</div>
                  <div className="text-[11px] text-muted-foreground">{progress}% complete</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Year heading */}
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: currentYear.color }}
          >
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-display font-bold text-lg">{currentYear.label} Year</h2>
            <p className="text-xs text-muted-foreground">
              {getProgress(activeYear)}% completed · {milestones.length} milestones
            </p>
          </div>
        </div>

        {/* Milestones timeline */}
        <div ref={timelineRef} className="relative">
          {/* Vertical line */}
          <div className="absolute left-5 top-0 bottom-0 w-px bg-border/60" />

          <div className="space-y-3">
            {milestones.map((milestone, i) => {
              const isCompleted = completedItems[activeYear]?.[i] ?? false;
              return (
                <div
                  key={`${activeYear}-${i}`}
                  data-milestone
                  className={`relative flex items-start gap-4 pl-10 p-4 rounded-xl border transition-all cursor-pointer group ${
                    isCompleted
                      ? "bg-primary/5 border-primary/20"
                      : "bg-card border-border/50 hover:border-primary/20"
                  }`}
                  onClick={() => toggleComplete(activeYear, i)}
                  data-testid={`milestone-${activeYear}-${i}`}
                >
                  {/* Circle on timeline */}
                  <div className="absolute left-3 top-5">
                    {isCompleted ? (
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                    ) : (
                      <Circle className="w-5 h-5 text-muted-foreground/40 group-hover:text-primary/50 transition-colors" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-sm font-medium ${isCompleted ? "line-through text-muted-foreground" : ""}`}>
                        {milestone.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] gap-1 py-0">
                        {categoryIcons[milestone.category]}
                        {milestone.category.charAt(0).toUpperCase() + milestone.category.slice(1)}
                      </Badge>
                    </div>
                  </div>

                  <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0 mt-1" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

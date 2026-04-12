import { useState, useEffect, useRef } from "react";
import { READINESS_QUESTIONS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  Target, ArrowRight, ArrowLeft, CheckCircle2, Sparkles,
  BookOpen, Briefcase, Users, Award, TrendingUp, BarChart3
} from "lucide-react";
import gsap from "gsap";

const SCORE_BREAKDOWN = [
  { label: "Academic Readiness", score: 82, icon: <BookOpen className="w-4 h-4" />, color: "hsl(var(--pathful-blue))" },
  { label: "Professional Experience", score: 65, icon: <Briefcase className="w-4 h-4" />, color: "hsl(var(--pathful-gold))" },
  { label: "Leadership & Extracurriculars", score: 78, icon: <Users className="w-4 h-4" />, color: "hsl(var(--pathful-green))" },
  { label: "Application Materials", score: 55, icon: <Award className="w-4 h-4" />, color: "hsl(var(--pathful-rose))" },
  { label: "Network & Connections", score: 42, icon: <TrendingUp className="w-4 h-4" />, color: "hsl(var(--pathful-teal))" },
];

export default function ReadinessPage() {
  const [quizStarted, setQuizStarted] = useState(false);
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [overallScore, setOverallScore] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);

  const progress = quizStarted ? ((currentQuestion + 1) / READINESS_QUESTIONS.length) * 100 : 0;

  useEffect(() => {
    if (quizCompleted && scoreRef.current) {
      // Animate score number counting up
      const scoreEl = scoreRef.current.querySelector("[data-score-value]");
      if (scoreEl) {
        gsap.fromTo(
          { val: 0 },
          { val: 72, duration: 1.5, ease: "power2.out", onUpdate: function () { scoreEl.textContent = Math.round(this.targets()[0].val).toString(); } }
        );
      }

      // Animate progress bars
      gsap.utils.toArray<HTMLElement>("[data-score-bar]").forEach((bar, i) => {
        gsap.from(bar, {
          width: 0,
          duration: 0.8,
          ease: "power2.out",
          delay: 0.3 + i * 0.1,
        });
      });
    }
  }, [quizCompleted]);

  const selectAnswer = (questionId: number, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  };

  const nextQuestion = () => {
    if (currentQuestion < READINESS_QUESTIONS.length - 1) {
      setCurrentQuestion((prev) => prev + 1);
    } else {
      setQuizCompleted(true);
      setOverallScore(72);
    }
  };

  const prevQuestion = () => {
    if (currentQuestion > 0) {
      setCurrentQuestion((prev) => prev - 1);
    }
  };

  const question = READINESS_QUESTIONS[currentQuestion];
  const hasAnswer = question && answers[question.id] !== undefined;

  // Quiz start view
  if (!quizStarted) {
    return (
      <div className="h-full overflow-auto" data-testid="page-readiness">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-6">
              <Target className="w-8 h-8" />
            </div>
            <h1 className="font-display font-bold text-xl mb-3" data-testid="text-page-title">
              Readiness Score
            </h1>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto leading-relaxed">
              Discover how prepared you are for your dream opportunities. 
              Take a quick 6-question quiz to get your personalized readiness score 
              and actionable insights.
            </p>

            <div className="grid grid-cols-3 gap-4 mb-10 max-w-sm mx-auto">
              <div className="text-center">
                <div className="font-display font-bold text-lg text-primary">6</div>
                <div className="text-xs text-muted-foreground">Questions</div>
              </div>
              <div className="text-center">
                <div className="font-display font-bold text-lg text-primary">2 min</div>
                <div className="text-xs text-muted-foreground">To complete</div>
              </div>
              <div className="text-center">
                <div className="font-display font-bold text-lg text-primary">Free</div>
                <div className="text-xs text-muted-foreground">Always</div>
              </div>
            </div>

            <Button
              onClick={() => setQuizStarted(true)}
              className="rounded-full px-8 py-5 font-semibold"
              data-testid="button-start-quiz"
            >
              Start Assessment
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Quiz results view
  if (quizCompleted) {
    return (
      <div ref={scoreRef} className="h-full overflow-auto" data-testid="page-readiness-results">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              Assessment Complete
            </div>
            <h1 className="font-display font-bold text-xl mb-2">Your Readiness Score</h1>
          </div>

          {/* Big score circle */}
          <div className="flex justify-center mb-10">
            <div className="relative w-40 h-40">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="52" fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
                <circle
                  cx="60" cy="60" r="52"
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth="8"
                  strokeDasharray={`${2 * Math.PI * 52}`}
                  strokeDashoffset={`${2 * Math.PI * 52 * (1 - 0.72)}`}
                  strokeLinecap="round"
                  className="transition-all duration-1000"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span data-score-value className="font-display font-bold text-3xl text-primary">0</span>
                <span className="text-xs text-muted-foreground">out of 100</span>
              </div>
            </div>
          </div>

          {/* Score interpretation */}
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 mb-8 text-center">
            <h3 className="font-display font-semibold text-sm mb-1">Good Progress — Keep Building</h3>
            <p className="text-xs text-muted-foreground">
              You're on track but have room to grow. Focus on professional experience and application materials to boost your score.
            </p>
          </div>

          {/* Breakdown */}
          <div className="space-y-4 mb-8">
            <h3 className="font-display font-semibold text-sm">Score Breakdown</h3>
            {SCORE_BREAKDOWN.map((item) => (
              <div key={item.label} className="p-4 rounded-xl bg-card border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span style={{ color: item.color }}>{item.icon}</span>
                    <span className="font-medium">{item.label}</span>
                  </div>
                  <span className="text-sm font-bold">{item.score}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    data-score-bar
                    className="h-full rounded-full transition-all"
                    style={{ width: `${item.score}%`, background: item.color }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Link href="/dashboard" className="flex-1">
              <Button className="w-full rounded-full" data-testid="button-view-opportunities">
                View Matching Opportunities
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/roadmap" className="flex-1">
              <Button variant="outline" className="w-full rounded-full" data-testid="button-view-roadmap">
                View Your Roadmap
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Quiz question view
  return (
    <div ref={pageRef} className="h-full overflow-auto" data-testid="page-readiness-quiz">
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-6">
        {/* Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
            <span>Question {currentQuestion + 1} of {READINESS_QUESTIONS.length}</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>

        {/* Question */}
        <div className="mb-8">
          <h2 className="font-display font-bold text-lg mb-6">
            {question.question}
          </h2>

          <div className="space-y-3">
            {question.options.map((option) => {
              const isSelected = answers[question.id] === option;
              return (
                <button
                  key={option}
                  onClick={() => selectAnswer(question.id, option)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border/60 bg-card hover:border-primary/30"
                  }`}
                  data-testid={`option-${option.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      isSelected ? "border-primary" : "border-muted-foreground/30"
                    }`}>
                      {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-primary" />}
                    </div>
                    <span className={`text-sm ${isSelected ? "font-medium" : ""}`}>{option}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={prevQuestion}
            disabled={currentQuestion === 0}
            className="rounded-full"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <Button
            onClick={nextQuestion}
            disabled={!hasAnswer}
            className="rounded-full px-6"
            data-testid="button-next-question"
          >
            {currentQuestion === READINESS_QUESTIONS.length - 1 ? "See Results" : "Next"}
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </div>
  );
}

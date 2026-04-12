import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { PathfulLogo } from "@/components/pathful-logo";
import { useTheme } from "@/components/theme-provider";
import { FEATURE_CATEGORIES, MOCK_STORIES } from "@/lib/constants";
import {
  Compass, Target, Users, Rss, FileText, Telescope,
  ArrowRight, ChevronDown, Sun, Moon, Star,
  GraduationCap, Briefcase, Award, CheckCircle2,
  Quote, MapPin, Heart
} from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const featureIcons: Record<string, React.ReactNode> = {
  Telescope: <Telescope className="w-6 h-6" />,
  Compass: <Compass className="w-6 h-6" />,
  Target: <Target className="w-6 h-6" />,
  Users: <Users className="w-6 h-6" />,
  Rss: <Rss className="w-6 h-6" />,
  FileText: <FileText className="w-6 h-6" />,
};

const STEPS = [
  { num: "01", title: "Sign Up", desc: "Create your profile in 2 minutes. Tell us your major, interests, and goals.", icon: <GraduationCap className="w-7 h-7" /> },
  { num: "02", title: "Take the Quiz", desc: "Our readiness assessment maps your strengths and identifies growth areas.", icon: <Target className="w-7 h-7" /> },
  { num: "03", title: "Get Your Roadmap", desc: "Receive a personalized career roadmap tailored to your year and goals.", icon: <Compass className="w-7 h-7" /> },
  { num: "04", title: "Discover & Apply", desc: "Browse curated opportunities matched to your profile and readiness.", icon: <Briefcase className="w-7 h-7" /> },
  { num: "05", title: "Track & Grow", desc: "Track applications, celebrate wins, and share your journey.", icon: <Award className="w-7 h-7" /> },
];

const STATS = [
  { value: "10,000+", label: "Opportunities" },
  { value: "500+", label: "Universities" },
  { value: "95%", label: "Match Accuracy" },
  { value: "50K+", label: "Students" },
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const storiesRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      // Hero text animation
      gsap.from("[data-hero-title] span", {
        y: 80,
        opacity: 0,
        rotationX: -40,
        duration: 1,
        ease: "power3.out",
        stagger: 0.08,
        delay: 0.3,
      });

      gsap.from("[data-hero-sub]", {
        y: 30,
        opacity: 0,
        duration: 0.8,
        ease: "power2.out",
        delay: 0.9,
      });

      gsap.from("[data-hero-cta]", {
        y: 20,
        opacity: 0,
        duration: 0.6,
        ease: "power2.out",
        delay: 1.2,
      });

      // Scroll-triggered feature cards
      gsap.utils.toArray<HTMLElement>("[data-feature-card]").forEach((card, i) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 60,
          opacity: 0,
          duration: 0.7,
          ease: "power2.out",
          delay: i * 0.1,
        });
      });

      // Steps animation
      gsap.utils.toArray<HTMLElement>("[data-step]").forEach((step, i) => {
        gsap.from(step, {
          scrollTrigger: {
            trigger: step,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          x: i % 2 === 0 ? -40 : 40,
          opacity: 0,
          duration: 0.7,
          ease: "power2.out",
          delay: i * 0.08,
        });
      });

      // Stats counter animation
      gsap.utils.toArray<HTMLElement>("[data-stat]").forEach((stat) => {
        gsap.from(stat, {
          scrollTrigger: {
            trigger: stat,
            start: "top 90%",
            toggleActions: "play none none none",
          },
          y: 30,
          opacity: 0,
          scale: 0.9,
          duration: 0.6,
          ease: "back.out(1.4)",
        });
      });

      // Stories
      gsap.utils.toArray<HTMLElement>("[data-story-card]").forEach((card, i) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 50,
          opacity: 0,
          rotation: gsap.utils.random(-3, 3),
          duration: 0.7,
          ease: "power2.out",
          delay: i * 0.12,
        });
      });

      // Section headings
      gsap.utils.toArray<HTMLElement>("[data-section-title]").forEach((title) => {
        gsap.from(title, {
          scrollTrigger: {
            trigger: title,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 40,
          opacity: 0,
          duration: 0.8,
          ease: "power3.out",
        });
      });
    });

    return () => ctx.revert();
  }, []);

  const scrollToFeatures = () => {
    featuresRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 px-4 pt-4" data-testid="nav-landing">
        <div className="max-w-6xl mx-auto bg-background/80 backdrop-blur-xl border border-border/50 rounded-full px-6 py-3 flex items-center justify-between shadow-lg">
          <PathfulLogo className="text-foreground" />
          <div className="hidden md:flex items-center gap-8">
            <button onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Features</button>
            <button onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">How It Works</button>
            <button onClick={() => document.getElementById('stories')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Stories</button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-full hover:bg-muted transition-colors"
              data-testid="button-theme-toggle"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link href="/dashboard">
              <span className="hidden sm:inline btn-pill bg-primary text-primary-foreground hover:opacity-90 text-sm cursor-pointer" data-testid="link-dashboard">
                Open App
              </span>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section
        ref={heroRef}
        className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-24 pb-16"
        style={{
          background: theme === "dark"
            ? "radial-gradient(ellipse at 50% 30%, hsl(220 50% 15%) 0%, hsl(220 45% 7%) 70%)"
            : "radial-gradient(ellipse at 50% 30%, hsl(220 40% 95%) 0%, hsl(40 33% 97%) 70%)",
        }}
      >
        {/* Decorative elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-[10%] w-64 h-64 rounded-full opacity-[0.07]"
            style={{ background: "hsl(var(--pathful-gold))" }} />
          <div className="absolute bottom-1/3 right-[15%] w-48 h-48 rounded-full opacity-[0.05]"
            style={{ background: "hsl(var(--pathful-teal))" }} />
          <div className="absolute top-1/2 left-[60%] w-32 h-32 rounded-full opacity-[0.06]"
            style={{ background: "hsl(var(--pathful-rose))" }} />
        </div>

        <div className="relative max-w-5xl mx-auto text-center z-10">
          {/* Tagline badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-8 rounded-full border border-border/60 bg-background/50 backdrop-blur-sm text-sm text-muted-foreground" data-hero-cta>
            <Star className="w-3.5 h-3.5 text-primary" fill="currentColor" />
            <span>The career platform for every student</span>
          </div>

          {/* Main headline */}
          <h1
            data-hero-title
            className="font-display font-bold tracking-tight leading-[1.05] mb-6"
            style={{ fontSize: "clamp(2.5rem, 1rem + 5vw, 5rem)" }}
          >
            <span className="inline-block">Find</span>{" "}
            <span className="inline-block">Your</span>{" "}
            <span className="inline-block text-primary">Path</span>
            <br />
            <span className="inline-block">Before</span>{" "}
            <span className="inline-block">It</span>{" "}
            <span className="inline-block">Finds</span>{" "}
            <span className="inline-block">You</span>
          </h1>

          <p
            data-hero-sub
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            Pathful is your career GPS — discovering internships, scholarships, research, and more,
            matched to who you are and where you're going.
          </p>

          <div data-hero-cta className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/readiness">
              <span className="btn-pill bg-primary text-primary-foreground shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 cursor-pointer" data-testid="link-get-started">
                Get Started — It's Free
                <ArrowRight className="w-4 h-4" />
              </span>
            </Link>
            <Link href="/dashboard">
              <span className="btn-pill bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-all flex items-center gap-2 cursor-pointer" data-testid="link-explore">
                Explore Opportunities
              </span>
            </Link>
          </div>
        </div>

        {/* Scroll indicator */}
        <button
          onClick={scrollToFeatures}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Scroll to features"
        >
          <span className="text-xs font-medium tracking-wide uppercase">Discover</span>
          <ChevronDown className="w-5 h-5 animate-bounce" />
        </button>
      </section>

      {/* Stats Bar */}
      <section ref={statsRef} className="py-12 px-6 bg-primary text-primary-foreground">
        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
          {STATS.map((stat) => (
            <div key={stat.label} data-stat className="text-center">
              <div className="font-display font-bold text-2xl md:text-3xl mb-1">{stat.value}</div>
              <div className="text-sm opacity-80">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features Section */}
      <section id="features" ref={featuresRef} className="py-20 md:py-28 px-6">
        <div className="max-w-6xl mx-auto">
          <div data-section-title className="text-center mb-16">
            <p className="text-sm font-semibold tracking-widest uppercase text-primary mb-3">
              Everything you need
            </p>
            <h2
              className="font-display font-bold tracking-tight mb-4"
              style={{ fontSize: "clamp(1.75rem, 1rem + 2vw, 3rem)" }}
            >
              Six Tools. One Platform.
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Pathful brings together everything a student needs to discover, prepare for, and land life-changing opportunities.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {Object.entries(FEATURE_CATEGORIES).map(([key, feature]) => (
              <div
                key={key}
                data-feature-card
                className="group relative p-6 rounded-2xl border border-border/60 bg-card hover:bg-card/80 hover:border-border transition-all hover:shadow-lg cursor-default"
                data-testid={`card-feature-${key}`}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 text-white"
                  style={{ background: `hsl(var(--pathful-${feature.color}))` }}
                >
                  {featureIcons[feature.icon]}
                </div>
                <h3 className="font-display font-semibold text-lg mb-2">{feature.label}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section
        id="how-it-works"
        ref={stepsRef}
        className="py-20 md:py-28 px-6"
        style={{
          background: theme === "dark"
            ? "hsl(220 40% 9%)"
            : "hsl(220 25% 95%)",
        }}
      >
        <div className="max-w-4xl mx-auto">
          <div data-section-title className="text-center mb-16">
            <p className="text-sm font-semibold tracking-widest uppercase text-primary mb-3">
              Simple as that
            </p>
            <h2
              className="font-display font-bold tracking-tight mb-4"
              style={{ fontSize: "clamp(1.75rem, 1rem + 2vw, 3rem)" }}
            >
              How Pathful Works
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              From sign-up to your first opportunity — in five clear steps.
            </p>
          </div>

          <div className="space-y-6">
            {STEPS.map((step, i) => (
              <div
                key={step.num}
                data-step
                className="flex items-start gap-5 p-5 md:p-6 rounded-2xl bg-card border border-border/40 hover:border-primary/30 transition-all"
                data-testid={`step-${i}`}
              >
                <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-display font-bold text-lg">
                  {step.num}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="text-primary">{step.icon}</span>
                    <h3 className="font-display font-semibold">{step.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Student Stories / Testimonials */}
      <section id="stories" ref={storiesRef} className="py-20 md:py-28 px-6">
        <div className="max-w-6xl mx-auto">
          <div data-section-title className="text-center mb-16">
            <p className="text-sm font-semibold tracking-widest uppercase text-primary mb-3">
              Real stories
            </p>
            <h2
              className="font-display font-bold tracking-tight mb-4"
              style={{ fontSize: "clamp(1.75rem, 1rem + 2vw, 3rem)" }}
            >
              Students Who Found Their Path
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Read about students who used Pathful to land their dream opportunities.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {MOCK_STORIES.slice(0, 4).map((story) => (
              <div
                key={story.id}
                data-story-card
                className="p-6 md:p-8 rounded-2xl border border-border/50 bg-card hover:shadow-md transition-all"
                data-testid={`card-story-${story.id}`}
              >
                <Quote className="w-8 h-8 text-primary/30 mb-4" />
                <p className="text-sm leading-relaxed text-foreground/90 mb-5 line-clamp-4">
                  {story.content}
                </p>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm">{story.authorName}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {story.university}
                    </div>
                  </div>
                  {story.category === "got-in" && story.opportunityTitle && (
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                      <CheckCircle2 className="w-3 h-3" />
                      Got In
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-3 text-xs text-muted-foreground">
                  <Heart className="w-3 h-3" />
                  <span>{story.likes}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section
        className="py-20 md:py-28 px-6"
        style={{
          background: theme === "dark"
            ? "linear-gradient(135deg, hsl(220 50% 12%) 0%, hsl(220 60% 18%) 100%)"
            : "linear-gradient(135deg, hsl(220 60% 25%) 0%, hsl(220 55% 35%) 100%)",
        }}
      >
        <div className="max-w-3xl mx-auto text-center text-white">
          <h2
            className="font-display font-bold tracking-tight mb-6"
            style={{ fontSize: "clamp(1.75rem, 1rem + 2.5vw, 3.5rem)" }}
          >
            Your Path Starts Here
          </h2>
          <p className="text-lg opacity-80 mb-10 max-w-xl mx-auto">
            Join thousands of students discovering opportunities they never knew existed. 
            It's free. It takes 2 minutes. And it could change everything.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/readiness">
              <span className="btn-pill bg-white text-gray-900 hover:bg-white/90 shadow-xl hover:shadow-2xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 cursor-pointer font-semibold" data-testid="link-cta-start">
                Start Your Journey
                <ArrowRight className="w-4 h-4" />
              </span>
            </Link>
            <Link href="/dashboard">
              <span className="btn-pill border-2 border-white/30 text-white hover:bg-white/10 transition-all cursor-pointer" data-testid="link-cta-browse">
                Browse Opportunities
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 bg-card border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-10 mb-10">
            <div className="md:col-span-1">
              <PathfulLogo className="text-foreground mb-4" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                The career GPS for every student. Discover, prepare, and land life-changing opportunities.
              </p>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-3">Discover</h4>
              <div className="space-y-2">
                <Link href="/dashboard" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Opportunities</Link>
                <Link href="/dashboard" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Scholarships</Link>
                <Link href="/dashboard" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Research</Link>
                <Link href="/dashboard" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Competitions</Link>
              </div>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-3">Your Path</h4>
              <div className="space-y-2">
                <Link href="/roadmap" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Career Roadmap</Link>
                <Link href="/readiness" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Readiness Score</Link>
                <Link href="/community" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Community</Link>
              </div>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-3">About</h4>
              <div className="space-y-2">
                <span className="block text-sm text-muted-foreground">Founded by Jose Cruz-Lopez, Rori Olaniyi & Abby Bravo</span>
                <span className="block text-sm text-muted-foreground">Launching Summer 2026</span>
              </div>
            </div>
          </div>
          <div className="border-t border-border/50 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">&copy; 2026 Pathful. All rights reserved.</p>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>Privacy</span>
              <span>Terms</span>
              <span>Contact</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

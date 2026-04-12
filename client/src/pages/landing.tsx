import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { PathfulLogo } from "@/components/pathful-logo";
import { useTheme } from "@/components/theme-provider";
import { FEATURE_CATEGORIES, MOCK_STORIES } from "@/lib/constants";
import {
  ArrowRight, ArrowLeft, ChevronDown, Sun, Moon,
  Telescope, Compass, Target, Users, Rss, FileText,
  GraduationCap, Briefcase, Award, CheckCircle2,
  Quote, MapPin, Heart, Star, Sparkles, Zap,
  Globe, BookOpen, Trophy, Send
} from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/* ============================================================
   SVG ILLUSTRATIONS — Flat vector Maxima-style
   ============================================================ */

function CloudSVG({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 80" className={className} fill="white" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="60" cy="50" rx="60" ry="30" />
      <ellipse cx="100" cy="35" rx="45" ry="35" />
      <ellipse cx="150" cy="50" rx="50" ry="28" />
    </svg>
  );
}

function HeroIllustration({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 600 500" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      {/* Compass base */}
      <circle cx="300" cy="240" r="180" fill="white" opacity="0.15" />
      <circle cx="300" cy="240" r="140" fill="white" opacity="0.12" />
      
      {/* Character body — blob shape */}
      <ellipse cx="300" cy="280" rx="100" ry="120" fill="#2668fd" />
      
      {/* Character face */}
      <circle cx="275" cy="250" r="8" fill="#1a1a2e" />
      <circle cx="325" cy="250" r="8" fill="#1a1a2e" />
      <path d="M280 280 Q300 300 320 280" stroke="#1a1a2e" strokeWidth="4" fill="none" strokeLinecap="round" />
      
      {/* Hat / graduation cap */}
      <rect x="250" y="170" width="100" height="12" rx="3" fill="#1a3a5c" />
      <polygon points="300,130 250,170 350,170" fill="#1a3a5c" />
      <line x1="300" y1="130" x2="300" y2="110" stroke="#ff6b35" strokeWidth="3" />
      <circle cx="300" cy="108" r="6" fill="#ff6b35" />
      
      {/* Arms holding compass */}
      <ellipse cx="190" cy="300" rx="35" ry="20" fill="#2668fd" transform="rotate(-20 190 300)" />
      <ellipse cx="410" cy="300" rx="35" ry="20" fill="#2668fd" transform="rotate(20 410 300)" />
      
      {/* Compass in hands */}
      <circle cx="300" cy="360" r="45" fill="white" stroke="#1a3a5c" strokeWidth="3" />
      <circle cx="300" cy="360" r="38" fill="#f8f5f0" />
      <polygon points="300,325 293,360 300,375 307,360" fill="#ff6b35" />
      <polygon points="300,395 293,360 300,345 307,360" fill="#1a3a5c" />
      <circle cx="300" cy="360" r="5" fill="#1a3a5c" />
      
      {/* Stars / sparkles around */}
      <polygon points="480,140 485,155 500,155 488,163 492,178 480,170 468,178 472,163 460,155 475,155" fill="#fdcb40" />
      <polygon points="140,180 143,190 153,190 145,196 148,206 140,200 132,206 135,196 127,190 137,190" fill="#ff6b35" />
      <polygon points="460,350 463,358 471,358 465,363 467,371 460,366 453,371 455,363 449,358 457,358" fill="#00b351" />
      
      {/* Floating path dots */}
      <circle cx="150" cy="120" r="12" fill="#fdcb40" opacity="0.8" />
      <circle cx="180" cy="100" r="8" fill="#fdcb40" opacity="0.5" />
      <circle cx="450" cy="100" r="10" fill="#f780d4" opacity="0.7" />
      <circle cx="500" cy="130" r="6" fill="#f780d4" opacity="0.4" />
      
      {/* Road/path element */}
      <path d="M80 450 Q200 400 300 430 Q400 460 520 410" stroke="white" strokeWidth="6" fill="none" strokeLinecap="round" opacity="0.3" strokeDasharray="12 8" />
    </svg>
  );
}

function FeatureIllustration({ feature }: { feature: string }) {
  const illustrations: Record<string, React.ReactNode> = {
    opportunities: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <circle cx="150" cy="150" r="120" fill="white" opacity="0.15" />
        <Telescope className="w-full h-full" style={{ padding: '80px' }} />
        {/* Telescope */}
        <rect x="120" y="100" width="80" height="30" rx="6" fill="white" transform="rotate(-30 160 115)" />
        <rect x="90" y="110" width="50" height="20" rx="4" fill="white" opacity="0.8" transform="rotate(-30 115 120)" />
        <circle cx="200" cy="80" r="8" fill="#fdcb40" />
        <circle cx="220" cy="100" r="5" fill="#fdcb40" opacity="0.5" />
        <polygon points="100,200 106,215 122,215 110,224 114,240 100,230 86,240 90,224 78,215 94,215" fill="white" opacity="0.6" />
      </svg>
    ),
    roadmap: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 250 Q100 180 150 200 Q200 220 200 150 Q200 80 250 60" stroke="white" strokeWidth="8" fill="none" strokeLinecap="round" strokeDasharray="0" />
        <circle cx="50" cy="250" r="12" fill="white" />
        <circle cx="150" cy="200" r="10" fill="white" opacity="0.8" />
        <circle cx="200" cy="150" r="10" fill="white" opacity="0.6" />
        <circle cx="250" cy="60" r="14" fill="white" />
        <polygon points="250,40 244,55 256,55" fill="white" />
      </svg>
    ),
    readiness: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <circle cx="150" cy="150" r="100" fill="white" opacity="0.12" />
        <circle cx="150" cy="150" r="80" fill="none" stroke="white" strokeWidth="12" strokeDasharray="380 120" strokeLinecap="round" transform="rotate(-90 150 150)" />
        <text x="150" y="160" textAnchor="middle" fill="white" fontSize="48" fontWeight="bold" fontFamily="Sora">92</text>
        <text x="150" y="185" textAnchor="middle" fill="white" fontSize="14" opacity="0.7" fontFamily="DM Sans">READY</text>
      </svg>
    ),
    community: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <circle cx="120" cy="130" r="30" fill="white" opacity="0.9" />
        <circle cx="120" cy="110" r="18" fill="white" />
        <circle cx="180" cy="130" r="30" fill="white" opacity="0.7" />
        <circle cx="180" cy="110" r="18" fill="white" opacity="0.8" />
        <circle cx="150" cy="170" r="35" fill="white" opacity="0.9" />
        <circle cx="150" cy="148" r="20" fill="white" />
        <path d="M100 200 Q150 230 200 200" stroke="white" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.5" />
      </svg>
    ),
    feed: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <rect x="80" y="60" width="140" height="80" rx="12" fill="white" opacity="0.9" />
        <rect x="60" y="110" width="140" height="80" rx="12" fill="white" opacity="0.7" transform="rotate(3 130 150)" />
        <rect x="100" y="160" width="140" height="80" rx="12" fill="white" opacity="0.5" transform="rotate(-2 170 200)" />
        <circle cx="110" cy="90" r="6" fill="#ff6b35" />
        <rect x="125" y="84" width="70" height="4" rx="2" fill="#ddd" />
        <rect x="125" y="94" width="50" height="4" rx="2" fill="#eee" />
      </svg>
    ),
    profiles: (
      <svg viewBox="0 0 300 300" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <rect x="70" y="70" width="160" height="200" rx="16" fill="white" opacity="0.9" />
        <rect x="90" y="90" width="120" height="60" rx="8" fill="#e0e7f0" />
        <rect x="90" y="165" width="80" height="6" rx="3" fill="#ccc" />
        <rect x="90" y="180" width="100" height="6" rx="3" fill="#ddd" />
        <rect x="90" y="195" width="60" height="6" rx="3" fill="#ddd" />
        <rect x="90" y="225" width="50" height="24" rx="12" fill="#2668fd" />
      </svg>
    ),
  };
  return <>{illustrations[feature] || null}</>;
}

/* ============================================================
   FEATURE SLIDES DATA
   ============================================================ */

const FEATURE_SLIDES = [
  {
    key: "opportunities",
    title: "OPPORTUNITY\nUNIVERSE",
    badge: "10,000+ Opportunities",
    bg: "#fdcb40",        // gold
    bgPale: "#fff8e1",
    textColor: "#1a1a2e",
  },
  {
    key: "roadmap",
    title: "CAREER\nROADMAP",
    badge: "Year by Year GPS",
    bg: "#00b351",        // green
    bgPale: "#e8f5e9",
    textColor: "white",
  },
  {
    key: "readiness",
    title: "READINESS\nSCORE",
    badge: "AI-Powered Assessment",
    bg: "#2668fd",        // blue
    bgPale: "#e3f2fd",
    textColor: "white",
  },
  {
    key: "community",
    title: "COMMUNITY\n& MENTORS",
    badge: "Real Student Stories",
    bg: "#f780d4",        // pink
    bgPale: "#fce4ec",
    textColor: "#1a1a2e",
  },
];

const STEPS = [
  { num: "01", title: "Sign Up", desc: "Create your profile in 2 minutes. Tell us your major, interests, and career goals.", icon: <GraduationCap className="w-8 h-8" /> },
  { num: "02", title: "Take the Quiz", desc: "Our readiness assessment maps your strengths and identifies growth areas.", icon: <Target className="w-8 h-8" /> },
  { num: "03", title: "Get Your Roadmap", desc: "Receive a personalized year-by-year career GPS tailored to your path.", icon: <Compass className="w-8 h-8" /> },
  { num: "04", title: "Discover & Apply", desc: "Browse curated opportunities matched to your profile and readiness score.", icon: <Briefcase className="w-8 h-8" /> },
];

/* ============================================================
   LANDING PAGE COMPONENT
   ============================================================ */

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();
  const [activeSlide, setActiveSlide] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);

  // Auto-rotate carousel
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % FEATURE_SLIDES.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // GSAP animations
  useEffect(() => {
    const ctx = gsap.context(() => {
      // Hero title words animate in staggered
      gsap.from("[data-hero-word]", {
        y: 120,
        opacity: 0,
        rotation: () => gsap.utils.random(-8, 8),
        scale: 0.85,
        duration: 0.9,
        ease: "back.out(1.4)",
        stagger: 0.1,
        delay: 0.4,
      });

      // Hero subtitle
      gsap.from("[data-hero-sub]", {
        y: 40,
        opacity: 0,
        duration: 0.8,
        ease: "power2.out",
        delay: 1.0,
      });

      // Hero CTAs
      gsap.from("[data-hero-cta]", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        ease: "power2.out",
        delay: 1.3,
      });

      // Nav animates in from top
      gsap.from("[data-nav]", {
        y: -100,
        opacity: 0,
        duration: 0.8,
        ease: "power3.out",
        delay: 0.2,
      });

      // Floating clouds
      gsap.to("[data-cloud-1]", {
        x: -200,
        duration: 25,
        ease: "none",
        repeat: -1,
        yoyo: true,
      });
      gsap.to("[data-cloud-2]", {
        x: 180,
        duration: 30,
        ease: "none",
        repeat: -1,
        yoyo: true,
      });
      gsap.to("[data-cloud-3]", {
        x: -150,
        duration: 35,
        ease: "none",
        repeat: -1,
        yoyo: true,
      });

      // Giant text section
      gsap.from("[data-giant-text] span", {
        scrollTrigger: {
          trigger: "[data-giant-text]",
          start: "top 80%",
          toggleActions: "play none none none",
        },
        y: 80,
        opacity: 0,
        duration: 0.9,
        ease: "power3.out",
        stagger: 0.12,
      });

      // Feature color sections — cards animate in
      gsap.utils.toArray<HTMLElement>("[data-feature-section]").forEach((section) => {
        gsap.from(section.querySelectorAll("[data-animate-in]"), {
          scrollTrigger: {
            trigger: section,
            start: "top 70%",
            toggleActions: "play none none none",
          },
          y: 60,
          opacity: 0,
          duration: 0.8,
          ease: "power2.out",
          stagger: 0.12,
        });
      });

      // Stacking cards
      gsap.utils.toArray<HTMLElement>("[data-stack-card]").forEach((card, i) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 80,
          opacity: 0,
          rotation: gsap.utils.random(-6, 6),
          scale: 0.92,
          duration: 0.7,
          ease: "back.out(1.2)",
          delay: i * 0.15,
        });
      });

      // Steps
      gsap.utils.toArray<HTMLElement>("[data-step]").forEach((step, i) => {
        gsap.from(step, {
          scrollTrigger: {
            trigger: step,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 50,
          opacity: 0,
          duration: 0.7,
          ease: "power2.out",
          delay: i * 0.1,
        });
      });

      // Story cards
      gsap.utils.toArray<HTMLElement>("[data-story-card]").forEach((card, i) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 60,
          opacity: 0,
          rotation: gsap.utils.random(-4, 4),
          duration: 0.7,
          ease: "back.out(1.3)",
          delay: i * 0.12,
        });
      });

      // Section titles
      gsap.utils.toArray<HTMLElement>("[data-section-heading]").forEach((el) => {
        gsap.from(el, {
          scrollTrigger: {
            trigger: el,
            start: "top 85%",
            toggleActions: "play none none none",
          },
          y: 50,
          opacity: 0,
          duration: 0.8,
          ease: "power3.out",
        });
      });

      // Footer card
      gsap.from("[data-footer-card]", {
        scrollTrigger: {
          trigger: "[data-footer-card]",
          start: "top 85%",
          toggleActions: "play none none none",
        },
        y: 60,
        opacity: 0,
        duration: 0.8,
        ease: "power2.out",
      });

    }, containerRef);

    return () => ctx.revert();
  }, []);

  const nextSlide = () => setActiveSlide((prev) => (prev + 1) % FEATURE_SLIDES.length);
  const prevSlide = () => setActiveSlide((prev) => (prev - 1 + FEATURE_SLIDES.length) % FEATURE_SLIDES.length);

  const slide = FEATURE_SLIDES[activeSlide];

  const featureEntries = Object.entries(FEATURE_CATEGORIES);

  return (
    <div ref={containerRef} className="overflow-x-hidden" style={{ background: "#f8f5f0" }}>

      {/* ============================================================
          NAVIGATION — Maxima-style floating pill nav
          ============================================================ */}
      <nav
        data-nav
        className="fixed top-0 left-0 right-0 z-50 pointer-events-none px-5 pt-5"
        data-testid="nav-landing"
      >
        <div className="max-w-6xl mx-auto pointer-events-auto">
          <div className="bg-white/90 backdrop-blur-xl rounded-full px-6 py-3 flex items-center justify-between"
            style={{ boxShadow: "0 4px 30px rgba(0,0,0,0.06)" }}>
            <PathfulLogo className="text-[#1a3a5c]" />
            <div className="hidden md:flex items-center gap-1">
              {["Features", "How It Works", "Stories"].map((item) => (
                <button
                  key={item}
                  onClick={() => {
                    const id = item.toLowerCase().replace(/\s+/g, '-');
                    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="px-5 py-2.5 rounded-full text-sm font-semibold text-[#1a3a5c] hover:bg-[#1a3a5c]/5 transition-colors"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-gray-100 transition-colors"
                data-testid="button-theme-toggle"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="w-4 h-4 text-[#1a3a5c]" /> : <Moon className="w-4 h-4 text-[#1a3a5c]" />}
              </button>
              <Link href="/dashboard">
                <span
                  className="hidden sm:flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-semibold text-white cursor-pointer transition-all hover:opacity-90 active:scale-[0.97]"
                  style={{ background: "#ff6b35", fontFamily: "var(--font-display)" }}
                  data-testid="link-dashboard"
                >
                  Get Started
                </span>
              </Link>
              <Link href="/dashboard">
                <span className="sm:hidden w-10 h-10 rounded-full flex items-center justify-center cursor-pointer"
                  style={{ background: "#ff6b35" }}>
                  <Send className="w-4 h-4 text-white" />
                </span>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* ============================================================
          HERO — Full-viewport carousel like Maxima
          ============================================================ */}
      <section
        ref={heroRef}
        className="relative w-full overflow-hidden"
        style={{ minHeight: "110svh", background: slide.bg, transition: "background 0.8s cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        {/* Floating clouds */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <CloudSVG data-cloud-1 className="absolute top-[15%] left-[5%] w-40 opacity-30" />
          <CloudSVG data-cloud-2 className="absolute top-[40%] right-[-5%] w-56 opacity-20" />
          <CloudSVG data-cloud-3 className="absolute bottom-[30%] left-[50%] w-32 opacity-25" />
        </div>

        {/* Illustration area */}
        <div className="absolute inset-0 flex items-center justify-center pt-16 pb-[30vh]">
          <div className="w-[50vw] max-w-[500px] transition-all duration-700" style={{ opacity: 1 }}>
            <HeroIllustration color={slide.bg} />
          </div>
        </div>

        {/* Bottom card with title — like Maxima's carousel card */}
        <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center">
          <div
            className="w-[90%] max-w-[700px] rounded-t-[2rem] px-10 pt-10 pb-14 text-center"
            style={{ background: "#ff6b35" }}
          >
            <h1
              className="font-display font-bold uppercase tracking-tight leading-[0.85] mb-4"
              style={{
                fontSize: "clamp(2.5rem, 5vw, 5rem)",
                color: "white",
                fontFamily: "var(--font-display)",
              }}
            >
              {slide.title.split("\n").map((line, i) => (
                <span key={i} data-hero-word className="inline-block">
                  {line}
                  {i < slide.title.split("\n").length - 1 && <br />}
                </span>
              ))}
            </h1>
            <span className="inline-block px-4 py-1.5 rounded text-sm font-medium"
              style={{
                background: "rgba(255,255,255,0.2)",
                color: "white",
                fontFamily: "var(--font-display)",
              }}>
              {slide.badge}
            </span>
          </div>
        </div>

        {/* Carousel arrows */}
        <button
          onClick={prevSlide}
          className="absolute left-6 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors z-10"
          style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}
          data-testid="button-prev-slide"
          aria-label="Previous slide"
        >
          <ArrowLeft className="w-5 h-5 text-[#1a3a5c]" />
        </button>
        <button
          onClick={nextSlide}
          className="absolute right-6 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors z-10"
          style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}
          data-testid="button-next-slide"
          aria-label="Next slide"
        >
          <ArrowRight className="w-5 h-5 text-[#1a3a5c]" />
        </button>

        {/* Slide indicators */}
        <div className="absolute right-8 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-10">
          {FEATURE_SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveSlide(i)}
              className="w-2.5 h-2.5 rounded-full transition-all"
              style={{
                background: i === activeSlide ? "#1a3a5c" : "rgba(26,58,92,0.3)",
                transform: i === activeSlide ? "scale(1.3)" : "scale(1)",
              }}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
      </section>

      {/* ============================================================
          TAGLINE SECTION — Big text like Maxima's "GROW" 
          ============================================================ */}
      <section className="py-24 md:py-32 px-6" style={{ background: "#f8f5f0" }}>
        <div className="max-w-6xl mx-auto text-center" data-giant-text>
          <h2
            className="font-display font-bold uppercase tracking-tight leading-[0.85]"
            style={{ fontSize: "clamp(3rem, 8vw, 10rem)", color: "#1a3a5c" }}
          >
            <span className="inline-block">THE</span>{" "}
            <span className="inline-block" style={{ color: "#ff6b35" }}>CAREER</span>{" "}
            <span className="inline-block">GPS</span>
            <br />
            <span className="inline-block">FOR</span>{" "}
            <span className="inline-block">EVERY</span>{" "}
            <span className="inline-block" style={{ color: "#2668fd" }}>STUDENT</span>
          </h2>
          <p
            data-hero-sub
            className="mt-8 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed"
            style={{ color: "#5a6a7a", fontFamily: "var(--font-sans)" }}
          >
            Pathful discovers internships, scholarships, research, fellowships, and competitions —
            matched to who you are and where you're going.
          </p>
          <div data-hero-cta className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/readiness">
              <span
                className="flex items-center gap-2 px-8 py-4 rounded-full text-white font-semibold cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: "#ff6b35", fontFamily: "var(--font-display)", fontSize: "1.1rem", boxShadow: "0 8px 30px rgba(255,107,53,0.3)" }}
                data-testid="link-get-started"
              >
                Start Your Journey
                <ArrowRight className="w-5 h-5" />
              </span>
            </Link>
            <Link href="/dashboard">
              <span
                className="flex items-center gap-2 px-8 py-4 rounded-full font-semibold cursor-pointer transition-all hover:bg-[#1a3a5c]/5"
                style={{ border: "2px solid #1a3a5c", color: "#1a3a5c", fontFamily: "var(--font-display)", fontSize: "1.1rem" }}
                data-testid="link-explore"
              >
                Explore Opportunities
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ============================================================
          FEATURES — Colored sections like Maxima's program pages
          ============================================================ */}
      <section id="features">
        {FEATURE_SLIDES.map((feat, i) => {
          const category = FEATURE_CATEGORIES[feat.key as keyof typeof FEATURE_CATEGORIES];
          if (!category) return null;
          const isEven = i % 2 === 0;

          return (
            <div
              key={feat.key}
              data-feature-section
              className="relative overflow-hidden"
              style={{ background: feat.bg, minHeight: "80vh" }}
            >
              {/* Floating clouds */}
              <CloudSVG className="absolute top-[10%] right-[5%] w-48 opacity-20" />
              <CloudSVG className="absolute bottom-[15%] left-[3%] w-32 opacity-15" />

              <div className="max-w-6xl mx-auto px-8 py-20 md:py-28">
                <div className={`flex flex-col ${isEven ? 'md:flex-row' : 'md:flex-row-reverse'} items-center gap-12 md:gap-16`}>
                  {/* Illustration side */}
                  <div data-animate-in className="flex-1 flex items-center justify-center">
                    <div className="w-64 h-64 md:w-80 md:h-80">
                      <FeatureIllustration feature={feat.key} />
                    </div>
                  </div>

                  {/* Content card — white floating card */}
                  <div data-animate-in className="flex-1">
                    <div
                      className="rounded-[1.5rem] p-8 md:p-12"
                      style={{
                        background: "white",
                        boxShadow: "0 20px 60px rgba(0,0,0,0.08)",
                      }}
                    >
                      <div
                        className="inline-block px-4 py-1.5 rounded-md text-xs font-semibold uppercase tracking-widest mb-5"
                        style={{ background: feat.bg + "20", color: feat.textColor === "white" ? feat.bg : feat.textColor }}
                      >
                        Feature {String(i + 1).padStart(2, '0')}
                      </div>
                      <h3
                        className="font-display font-bold tracking-tight mb-4"
                        style={{ fontSize: "clamp(1.5rem, 2.5vw, 2.5rem)", color: "#1a3a5c", lineHeight: 1.1 }}
                      >
                        {category.label}
                      </h3>
                      <p className="text-base leading-relaxed mb-6" style={{ color: "#5a6a7a" }}>
                        {category.description}
                      </p>
                      <Link href="/dashboard">
                        <span
                          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold cursor-pointer transition-all hover:opacity-90"
                          style={{ background: feat.bg, color: feat.textColor, fontFamily: "var(--font-display)" }}
                        >
                          Explore {category.label}
                          <ArrowRight className="w-4 h-4" />
                        </span>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* ============================================================
          STACKING CARDS — All 6 features fanning out
          ============================================================ */}
      <section className="py-24 md:py-32 px-6" style={{ background: "#f8f5f0" }}>
        <div className="max-w-5xl mx-auto">
          <div data-section-heading className="text-center mb-16">
            <h2
              className="font-display font-bold uppercase tracking-tight mb-4"
              style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)", color: "#1a3a5c" }}
            >
              Everything You Need
            </h2>
            <p className="text-lg max-w-xl mx-auto" style={{ color: "#5a6a7a" }}>
              Six powerful tools. One platform. Built for students who refuse to settle.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featureEntries.map(([key, feature], i) => {
              const colors: Record<string, string> = {
                gold: "#fdcb40", green: "#00b351", blue: "#2668fd",
                rose: "#f780d4", accent: "#ff6b35", teal: "#2cd1d0",
              };
              const icons: Record<string, React.ReactNode> = {
                Telescope: <Telescope className="w-7 h-7" />,
                Compass: <Compass className="w-7 h-7" />,
                Target: <Target className="w-7 h-7" />,
                Users: <Users className="w-7 h-7" />,
                Rss: <Rss className="w-7 h-7" />,
                FileText: <FileText className="w-7 h-7" />,
              };

              return (
                <div
                  key={key}
                  data-stack-card
                  className="rounded-[1.5rem] p-7 transition-all hover:scale-[1.02] cursor-default"
                  style={{
                    background: "white",
                    boxShadow: "0 8px 30px rgba(0,0,0,0.06)",
                  }}
                  data-testid={`card-feature-${key}`}
                >
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
                    style={{ background: colors[feature.color] || "#2668fd", color: "white" }}
                  >
                    {icons[feature.icon]}
                  </div>
                  <h3 className="font-display font-bold text-lg mb-2" style={{ color: "#1a3a5c" }}>
                    {feature.label}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: "#5a6a7a" }}>
                    {feature.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============================================================
          HOW IT WORKS — White card over colored background
          ============================================================ */}
      <section
        id="how-it-works"
        className="relative overflow-hidden"
        style={{ background: "#1a3a5c" }}
      >
        <CloudSVG className="absolute top-[5%] right-[10%] w-48 opacity-5" />
        <CloudSVG className="absolute bottom-[10%] left-[5%] w-36 opacity-5" />

        <div className="max-w-5xl mx-auto px-6 py-24 md:py-32">
          <div data-section-heading className="text-center mb-16">
            <h2
              className="font-display font-bold uppercase tracking-tight mb-4"
              style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)", color: "white" }}
            >
              How Pathful Works
            </h2>
            <p className="text-lg max-w-xl mx-auto" style={{ color: "rgba(255,255,255,0.65)" }}>
              From sign-up to your first opportunity — in four clear steps.
            </p>
          </div>

          {/* White floating card with steps */}
          <div
            className="rounded-[1.5rem] p-8 md:p-12"
            style={{ background: "white", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}
          >
            <div className="space-y-6">
              {STEPS.map((step, i) => (
                <div
                  key={step.num}
                  data-step
                  className="flex items-start gap-6 p-5 rounded-2xl hover:bg-[#f8f5f0] transition-colors"
                  data-testid={`step-${i}`}
                >
                  <div
                    className="flex-shrink-0 w-16 h-16 rounded-2xl flex items-center justify-center"
                    style={{ background: "#ff6b35", color: "white" }}
                  >
                    {step.icon}
                  </div>
                  <div className="flex-1 pt-1">
                    <div className="flex items-center gap-3 mb-1.5">
                      <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#ff6b35", fontFamily: "var(--font-display)" }}>
                        Step {step.num}
                      </span>
                    </div>
                    <h3 className="font-display font-bold text-lg mb-1" style={{ color: "#1a3a5c" }}>
                      {step.title}
                    </h3>
                    <p className="text-sm leading-relaxed" style={{ color: "#5a6a7a" }}>
                      {step.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          TESTIMONIALS — Large quote blocks like Maxima
          ============================================================ */}
      <section id="stories" className="py-24 md:py-32 px-6" style={{ background: "#f8f5f0" }}>
        <div className="max-w-6xl mx-auto">
          <div data-section-heading className="text-center mb-16">
            <h2
              className="font-display font-bold uppercase tracking-tight mb-4"
              style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)", color: "#1a3a5c" }}
            >
              Students Who Found Their Path
            </h2>
            <p className="text-lg max-w-xl mx-auto" style={{ color: "#5a6a7a" }}>
              Real stories from students who used Pathful to land life-changing opportunities.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {MOCK_STORIES.slice(0, 4).map((story, i) => {
              const cardColors = ["#fdcb40", "#2668fd", "#00b351", "#f780d4"];
              const bgColor = cardColors[i % cardColors.length];
              const textIsLight = i === 1 || i === 2;

              return (
                <div
                  key={story.id}
                  data-story-card
                  className="rounded-[1.5rem] overflow-hidden"
                  style={{ background: bgColor }}
                  data-testid={`card-story-${story.id}`}
                >
                  <div className="p-8 md:p-10">
                    {/* Giant quote mark */}
                    <div className="mb-4" style={{ color: textIsLight ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.1)" }}>
                      <Quote className="w-12 h-12" />
                    </div>

                    <p
                      className="text-base md:text-lg leading-relaxed mb-6 line-clamp-4"
                      style={{ color: textIsLight ? "white" : "#1a1a2e", fontFamily: "var(--font-sans)" }}
                    >
                      {story.content}
                    </p>

                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-sm" style={{ color: textIsLight ? "white" : "#1a1a2e", fontFamily: "var(--font-display)" }}>
                          {story.authorName}
                        </div>
                        <div className="flex items-center gap-1 text-xs mt-0.5" style={{ color: textIsLight ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)" }}>
                          <MapPin className="w-3 h-3" />
                          {story.university}
                        </div>
                      </div>
                      {story.category === "got-in" && story.opportunityTitle && (
                        <div
                          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold"
                          style={{
                            background: "white",
                            color: bgColor === "#fdcb40" ? "#1a1a2e" : bgColor,
                            fontFamily: "var(--font-display)",
                          }}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Got In!
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============================================================
          STATS — Over bold colored section
          ============================================================ */}
      <section style={{ background: "#2668fd" }} className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {[
              { value: "10,000+", label: "Opportunities" },
              { value: "500+", label: "Universities" },
              { value: "95%", label: "Match Accuracy" },
              { value: "50K+", label: "Students" },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="font-display font-bold text-3xl md:text-4xl mb-1" style={{ color: "white" }}>
                  {stat.value}
                </div>
                <div className="text-sm" style={{ color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-display)" }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================================
          CTA SECTION
          ============================================================ */}
      <section className="py-24 md:py-32 px-6" style={{ background: "#f8f5f0" }}>
        <div className="max-w-4xl mx-auto text-center">
          <h2
            className="font-display font-bold uppercase tracking-tight mb-6"
            style={{ fontSize: "clamp(2rem, 5vw, 4.5rem)", color: "#1a3a5c", lineHeight: 0.9 }}
          >
            Your Path<br />
            <span style={{ color: "#ff6b35" }}>Starts Here</span>
          </h2>
          <p className="text-lg mb-10 max-w-xl mx-auto" style={{ color: "#5a6a7a" }}>
            Join thousands of students discovering opportunities they never knew existed.
            It's free. It takes 2 minutes. And it could change everything.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/readiness">
              <span
                className="flex items-center gap-2 px-8 py-4 rounded-full text-white font-semibold cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: "#ff6b35", fontFamily: "var(--font-display)", fontSize: "1.1rem", boxShadow: "0 8px 30px rgba(255,107,53,0.3)" }}
                data-testid="link-cta-start"
              >
                Start Your Journey
                <ArrowRight className="w-5 h-5" />
              </span>
            </Link>
            <Link href="/dashboard">
              <span
                className="flex items-center gap-2 px-8 py-4 rounded-full font-semibold cursor-pointer transition-all hover:bg-[#1a3a5c]/5"
                style={{ border: "2px solid #1a3a5c", color: "#1a3a5c", fontFamily: "var(--font-display)", fontSize: "1.1rem" }}
                data-testid="link-cta-browse"
              >
                Browse Opportunities
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ============================================================
          FOOTER — Maxima-style floating white card on colored bg
          ============================================================ */}
      <footer style={{ background: "#00b351" }} className="px-5 pt-5 pb-8">
        {/* Floating white card */}
        <div
          data-footer-card
          className="max-w-6xl mx-auto rounded-[1.5rem] p-10 md:p-14"
          style={{ background: "white" }}
        >
          <div className="grid md:grid-cols-[2fr_1fr_1fr_1fr] gap-10 mb-12">
            <div>
              <PathfulLogo className="text-[#1a3a5c] mb-4" />
              <p className="text-sm leading-relaxed" style={{ color: "#5a6a7a", maxWidth: "260px" }}>
                The career GPS for every student. Discover, prepare, and land life-changing opportunities.
              </p>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-4" style={{ color: "#1a3a5c" }}>Discover</h4>
              <div className="space-y-2.5">
                {["Opportunities", "Scholarships", "Research", "Competitions"].map((item) => (
                  <Link key={item} href="/dashboard" className="block text-sm transition-colors hover:text-[#1a3a5c]" style={{ color: "#5a6a7a" }}>
                    {item}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-4" style={{ color: "#1a3a5c" }}>Your Path</h4>
              <div className="space-y-2.5">
                {[
                  { label: "Career Roadmap", href: "/roadmap" },
                  { label: "Readiness Score", href: "/readiness" },
                  { label: "Community", href: "/community" },
                ].map((item) => (
                  <Link key={item.label} href={item.href} className="block text-sm transition-colors hover:text-[#1a3a5c]" style={{ color: "#5a6a7a" }}>
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <h4 className="font-display font-semibold text-sm mb-4" style={{ color: "#1a3a5c" }}>About</h4>
              <div className="space-y-2.5 text-sm" style={{ color: "#5a6a7a" }}>
                <p>Founded by Jose Cruz-Lopez, Rori Olaniyi & Abby Bravo</p>
                <p>Launching Summer 2026</p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 flex flex-col sm:flex-row items-center justify-between gap-4" style={{ borderColor: "#eee" }}>
            <p className="text-xs" style={{ color: "#999" }}>&copy; 2026 Pathful. All rights reserved.</p>
            <div className="flex items-center gap-6 text-xs" style={{ color: "#999" }}>
              <span className="hover:text-[#1a3a5c] cursor-pointer transition-colors">Privacy</span>
              <span className="hover:text-[#1a3a5c] cursor-pointer transition-colors">Terms</span>
              <span className="hover:text-[#1a3a5c] cursor-pointer transition-colors">Contact</span>
            </div>
          </div>
        </div>

        {/* Giant wordmark below card */}
        <div className="max-w-6xl mx-auto mt-10 text-center">
          <div
            className="font-display font-bold uppercase tracking-tight"
            style={{
              fontSize: "clamp(3rem, 12vw, 10rem)",
              color: "rgba(255,255,255,0.15)",
              lineHeight: 0.9,
            }}
          >
            PATHFUL
          </div>
          <p className="text-sm mt-4" style={{ color: "rgba(255,255,255,0.5)" }}>
            Find your path before it finds you.
          </p>
        </div>
      </footer>
    </div>
  );
}

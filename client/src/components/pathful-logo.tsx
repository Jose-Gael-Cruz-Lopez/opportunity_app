interface PathfulLogoProps {
  className?: string;
  iconOnly?: boolean;
}

export function PathfulLogo({ className = "", iconOnly = false }: PathfulLogoProps) {
  if (iconOnly) {
    return (
      <svg
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Pathful"
      >
        {/* Compass rose / path icon */}
        <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="2.5" />
        <path
          d="M20 6L23 17L34 20L23 23L20 34L17 23L6 20L17 17L20 6Z"
          fill="currentColor"
          opacity="0.9"
        />
        <circle cx="20" cy="20" r="3" fill="currentColor" />
      </svg>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-8 h-8"
        aria-label="Pathful"
      >
        <circle cx="18" cy="18" r="16" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M18 5L20.5 15L31 18L20.5 21L18 31L15.5 21L5 18L15.5 15L18 5Z"
          fill="currentColor"
          opacity="0.9"
        />
        <circle cx="18" cy="18" r="2.5" fill="currentColor" />
      </svg>
      <span
        className="text-lg font-bold tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        pathful
      </span>
    </div>
  );
}

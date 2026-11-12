import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type PanelTag = "div" | "section" | "article" | "aside" | "nav" | "header" | "form" | "li";

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: PanelTag;
  /** strong: rail and bars; dark: the darker stat tile. */
  tone?: "default" | "strong" | "dark";
  /** The iridescent rim; use on one hero card per page. */
  iris?: boolean;
  children?: ReactNode;
}

/**
 * The basic surface. Solid by default and frosted glass only where the glass gate allows it,
 * so text contrast never depends on what is behind the panel.
 */
export function Panel({ as: Tag = "div", tone = "default", iris = false, className, children, ...rest }: PanelProps) {
  return (
    <Tag className={cn("nv-glass", tone === "strong" && "nv-glass-strong", tone === "dark" && "nv-glass-dark", iris && "nv-iris", className)} {...rest}>
      {children}
    </Tag>
  );
}

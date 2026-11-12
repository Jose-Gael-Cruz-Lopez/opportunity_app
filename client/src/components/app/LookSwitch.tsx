import { useRef, type KeyboardEvent } from "react";
import { LOOK_LABELS, LOOKS, useLook, type Look } from "@/design";

/**
 * Meadow / Ember switch. A radio group: one tab stop, arrow keys move and select, as the
 * WAI-ARIA radio pattern expects.
 */
export function LookSwitch() {
  const { look, setLook } = useLook();
  const refs = useRef<Partial<Record<Look, HTMLButtonElement | null>>>({});
  const order: readonly Look[] = ["meadow", "ember"];
  // Literal class names: Tailwind drops @layer classes it cannot find verbatim in the source.
  const swatch: Record<Look, string> = { meadow: "nv-lk nv-lk-meadow", ember: "nv-lk nv-lk-ember" };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = order[(order.indexOf(look) + step + order.length) % order.length] as Look;
    setLook(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="nv-looks" role="radiogroup" aria-label="Look" onKeyDown={onKeyDown}>
      {order
        .filter((l) => LOOKS.includes(l))
        .map((l) => (
          <button
            key={l}
            ref={(el) => {
              refs.current[l] = el;
            }}
            type="button"
            role="radio"
            aria-checked={look === l}
            tabIndex={look === l ? 0 : -1}
            onClick={() => setLook(l)}
          >
            <i className={swatch[l]} aria-hidden="true" />
            <span>{LOOK_LABELS[l]}</span>
          </button>
        ))}
    </div>
  );
}

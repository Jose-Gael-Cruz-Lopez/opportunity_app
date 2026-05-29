type Surface = {
  label: string;
  title: string;
  description: string;
  discipline: string;
  role: string;
  timeline: string;
  Visual: () => JSX.Element;
};

const COBALT = "#1F2BFA";
const PAGE_BG = "#EFECE6";
const DARK_BG = "#0B0B0B";
const OPEN_GREEN = "#B6F25C";
const MOCKUP_BG = "#FAFAF7";

const SURFACES: Surface[] = [];

export function WorkflowSection() {
  return (
    <section
      className="relative w-full"
      style={{ height: `${SURFACES.length * 100}vh`, background: PAGE_BG }}
    />
  );
}

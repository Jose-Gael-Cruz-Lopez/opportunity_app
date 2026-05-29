type Surface = {
  label: string;
  title: string;
  description: string;
  discipline: string;
  role: string;
  timeline: string;
  Visual: () => JSX.Element;
};

export function WorkflowSection() {
  return <section className="relative w-full" />;
}

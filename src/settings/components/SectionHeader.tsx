import type { ReactNode } from "react";

type Props = {
  title: string;
  description?: string;
  /** Optional glyph rendered to the left of the title (e.g. brand logo). */
  icon?: ReactNode;
};

export function SectionHeader({ title, description, icon }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2 text-[16px] font-semibold tracking-tight">
        {icon ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
        {title}
      </h1>
      {description ? (
        <p className="text-[12px] text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

import type { TestStep } from "@/modules/ado";

type Props = {
  steps: TestStep[];
};

/**
 * Read-only steps table. The Action / Expected text is plain — we strip
 * HTML when we parse from ADO (see steps_xml::strip_html in Rust).
 */
export function StepsTable({ steps }: Props) {
  if (steps.length === 0) {
    return (
      <p className="text-[11.5px] italic text-muted-foreground">
        No steps recorded on this test case.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/50 text-[10.5px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-1.5 text-left font-medium">#</th>
            <th className="px-2 py-1.5 text-left font-medium">Action</th>
            <th className="px-2 py-1.5 text-left font-medium">
              Expected Result
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr
              key={s.index}
              className="border-t border-border/40 align-top"
            >
              <td className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {s.index}
              </td>
              <td className="whitespace-pre-wrap px-2 py-1.5">{s.action}</td>
              <td className="whitespace-pre-wrap px-2 py-1.5">{s.expected}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

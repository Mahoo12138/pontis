// The one shape a settings section heading takes.
//
// The options page had three: `Section` with `.pontis-sectionTitle` on three
// tabs, nested `Divider label=` sub-headings on the 起始页 tab, and a bare
// `Title order={3}` inside the binding cards. The 起始页 tab's variant was the
// odd one out — it read as a second level that no other tab has — so both the
// wrapper and the bare heading live here now, and a tab picks one shape.

import type { ReactNode } from 'react';
import { Group } from '@mantine/core';

/** A heading on its own, for a flat list of sections that manage their own spacing. */
export function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <div className="pontis-sectionTitle">{title}</div>
      {hint && <div className="pontis-sectionHint">{hint}</div>}
    </div>
  );
}

/** A page section: a 13/600 title, an optional 12px hint, actions on the right. */
export function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pontis-section">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb={hint ? 4 : 'sm'}>
        <SectionHeading title={title} hint={hint} />
        {right}
      </Group>
      {children}
    </section>
  );
}

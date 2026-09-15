import React from 'react';
import { Column, Expander } from '@husklet/react';

type DisclosureSectionProps = {
  label: string;
  tooltip: string;
  children: React.ReactNode;
};

/** A full-width, visibly bounded disclosure for secondary controls inside a detail surface. */
export function DisclosureSection({ label, tooltip, children }: DisclosureSectionProps) {
  return (
    <Expander
      label={label}
      tooltip={tooltip}
      expanded={false}
      variant="outline"
      width="fill"
      align="stretch"
    >
      <Column gap={1} width="fill" pad={{ top: 1, end: 1, bottom: 1, start: 1 }}>
        {children}
      </Column>
    </Expander>
  );
}

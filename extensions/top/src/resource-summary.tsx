import React from 'react';
import { CardContent, CardHeader, Row } from '@husklet/react';

type ResourceSummaryCommon = {
  status?: React.ReactNode;
  actions: React.ReactNode;
  overflow?: React.ReactNode;
};

type ResourceSummaryProps = ResourceSummaryCommon &
  (
    | { label: string; detail?: string; summary?: never }
    | {
        /** A structured identity block for resources whose exact values must remain selectable. */
        summary: React.ReactNode;
        label?: never;
        detail?: never;
      }
  );

/** A compact, wrapping identity/status/action line for Top inventory cards. */
export function ResourceSummary({
  label,
  detail,
  summary,
  status,
  actions,
  overflow,
}: ResourceSummaryProps) {
  if (!summary && !label)
    throw new TypeError('ResourceSummary needs a label or structured summary');
  return (
    <CardContent gap={1} align="center" width="fill">
      <Row gap={2} align="center" justify="start" wrap width="fill">
        {summary ?? <CardHeader label={label} detail={detail} align="start" grow width="fill" />}
        <Row gap={1} align="center" justify="start" wrap>
          {status}
          {actions}
          {overflow}
        </Row>
      </Row>
    </CardContent>
  );
}

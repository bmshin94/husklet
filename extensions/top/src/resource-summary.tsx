import React from 'react';
import { CardActions, CardContent, CardHeader, Responsive, Row, Spacer } from '@husklet/react';

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
  const identity = (minimum: number) =>
    summary ?? (
      <CardHeader
        label={label}
        detail={detail}
        align="start"
        width={{ minimum: { chars: minimum }, maximum: { chars: 32 } }}
      />
    );
  return (
    <CardContent gap={1} align="center" width="fill">
      <Responsive alternate breakpoint={720} width="fill">
        <Row gap={2} align="stretch" justify="center" wrap width="fill">
          {identity(12)}
          {status}
          <CardActions gap={1} align="center" justify="center">
            {centered(actions)}
            {centered(overflow)}
          </CardActions>
        </Row>
        <Row gap={2} align="stretch" justify="center" width="fill" height={{ step: 11 }}>
          {identity(20)}
          {status}
          <Spacer width="fill" />
          <CardActions gap={1} align="center" justify="center">
            {centered(actions)}
            {centered(overflow)}
          </CardActions>
        </Row>
      </Responsive>
    </CardContent>
  );
}

/** Keep every control at its native hit target when its responsive row is taller. */
function centered(nodes: React.ReactNode): React.ReactNode {
  return React.Children.map(nodes, (child) => {
    if (!React.isValidElement(child)) return child;
    if (child.type === React.Fragment) {
      return <React.Fragment key={child.key}>{centered(child.props.children)}</React.Fragment>;
    }
    return React.cloneElement(child as React.ReactElement<{ justify?: 'center' }>, {
      justify: 'center',
    });
  });
}

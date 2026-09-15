import React from 'react';
import {
  Button,
  CardActions,
  CardContent,
  CardHeader,
  Column,
  InlineMessage,
  Responsive,
  Row,
  Spinner,
  Spacer,
  Text,
} from '@husklet/react';

type ResourceDanger = {
  authorityKey: string;
  label: string;
  tooltip: string;
  question: string;
  confirmLabel: string;
  pendingLabel: string;
  onConfirm: () => void | Promise<void>;
  enabled?: boolean;
};

const errorEncoder = new TextEncoder();

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? 'The operation failed.');
  let result = '';
  for (const character of message || 'The operation failed.') {
    if (errorEncoder.encode(result + character).byteLength > 1024) break;
    result += character;
  }
  return result;
}

type ResourceSummaryCommon = {
  status?: React.ReactNode;
  actions: React.ReactNode;
  overflow?: {
    label: string;
    tooltip: string;
    content: React.ReactNode;
  };
  danger?: ResourceDanger;
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
  danger,
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
  const [confirmation, setConfirmation] = React.useState({
    authority: '',
    pending: false,
    error: '',
  });
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const active = danger && confirmation.authority === danger.authorityKey;
  const openDanger = () => {
    if (!danger) return;
    setConfirmation({ authority: danger.authorityKey, pending: false, error: '' });
  };
  const closeDanger = () => setConfirmation({ authority: '', pending: false, error: '' });
  const confirmDanger = async () => {
    if (!danger || !active || confirmation.pending) return;
    const authority = danger.authorityKey;
    setConfirmation({ authority, pending: true, error: '' });
    try {
      await danger.onConfirm();
      setConfirmation((current) =>
        current.authority === authority ? { authority: '', pending: false, error: '' } : current,
      );
    } catch (cause) {
      setConfirmation((current) =>
        current.authority === authority
          ? { authority, pending: false, error: boundedError(cause) }
          : current,
      );
    }
  };
  const dangerTrigger = danger ? (
    <Button
      label={danger.label}
      tooltip={danger.tooltip}
      tone="danger"
      variant="ghost"
      size="small"
      enabled={danger.enabled !== false && !confirmation.pending}
      onInvoke={openDanger}
    />
  ) : null;
  const overflowTrigger = overflow ? (
    <Button
      label={overflowOpen ? 'Close actions' : overflow.label}
      tooltip={overflow.tooltip}
      icon="view-more-symbolic"
      variant="ghost"
      size="small"
      onInvoke={() => setOverflowOpen((open) => !open)}
    />
  ) : null;
  return (
    <>
      <CardContent gap={1} align="center" width="fill">
        <Responsive alternate breakpoint={720} width="fill">
          <Row gap={2} align="stretch" justify="center" wrap width="fill">
            {identity(12)}
            {status}
            <CardActions gap={1} align="center" justify="center">
              {centered(actions)}
              {centered(overflowTrigger)}
              {centered(dangerTrigger)}
            </CardActions>
          </Row>
          <Row gap={2} align="stretch" justify="center" width="fill" height={{ step: 11 }}>
            {identity(20)}
            {status}
            <Spacer width="fill" />
            <CardActions gap={1} align="center" justify="center">
              {centered(actions)}
              {centered(overflowTrigger)}
              {centered(dangerTrigger)}
            </CardActions>
          </Row>
        </Responsive>
      </CardContent>
      {overflow && overflowOpen ? (
        <CardContent width="fill" align="start" pad={2}>
          <Column gap={1} width="fill">
            {overflow.content}
          </Column>
        </CardContent>
      ) : null}
      {active ? (
        <CardContent width="fill" align="start">
          <Column gap={1} width="fill">
            <Text label={danger.question} color="warning" wrap />
            <Row gap={1} align="center" justify="start" wrap width="fill">
              {confirmation.pending ? <Spinner busy /> : null}
              <Button
                label={confirmation.pending ? danger.pendingLabel : danger.confirmLabel}
                tone="danger"
                destructive
                variant="filled"
                size="small"
                enabled={!confirmation.pending}
                onInvoke={() => void confirmDanger()}
              />
              <Button
                label="Cancel"
                size="small"
                enabled={!confirmation.pending}
                onInvoke={closeDanger}
              />
            </Row>
            {confirmation.error ? <InlineMessage label={confirmation.error} tone="danger" /> : null}
          </Column>
        </CardContent>
      ) : null}
    </>
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

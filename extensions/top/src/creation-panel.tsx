import React from 'react';
import { Button, Column, Paper, Row } from '@husklet/react';

export function CreationPanel({
  action,
  cancel,
  open,
  enabled = true,
  secondary,
  onOpenChange,
  children,
}: {
  action: string;
  cancel: string;
  open: boolean;
  enabled?: boolean;
  secondary?: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <Row gap={1} align="center" justify="start" wrap width="fill">
        <Button
          label={open ? cancel : action}
          icon={open ? 'window-close-symbolic' : 'list-add-symbolic'}
          size="small"
          variant={open ? 'ghost' : 'outline'}
          enabled={enabled}
          onInvoke={() => onOpenChange(!open)}
        />
        {secondary}
      </Row>
      <Paper visible={open} variant="outline" width="fill" pad={2}>
        <Column gap={2}>{children}</Column>
      </Paper>
    </>
  );
}

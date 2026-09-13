import React, { useState } from 'react';
import { Column, RecoveryState, Text } from '@husklet/react';

export function RecoveryStateStory() {
  const [attempt, setAttempt] = useState(1);
  return (
    <Column gap={2} width="fill">
      <Text
        label="Recovery leads with an actionable summary and keeps bounded diagnostics secondary."
        wrap
      />
      <RecoveryState
        operation="Container inventory"
        error={`socket closed during attempt ${attempt}`}
        retryLabel="Try again"
        onRetry={() => setAttempt((current) => current + 1)}
      />
      <Text label={`Retry attempts · ${attempt}`} color="text-dim" />
      <Column gap={2} width="fill" pad={{ top: 2 }}>
        <Text label="Partial result" scale="title" />
        <RecoveryState
          summary="1 container snapshot unavailable; available rows remain visible."
          tone="warning"
          error="worker: process endpoint did not respond"
        />
      </Column>
    </Column>
  );
}

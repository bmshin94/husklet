import React, { useState } from 'react';
import { Column, ConfirmAction, Heading, InlineMessage, Row, Text } from '@husklet/react';
import { ApiReference, DocumentationSection, FieldSpecimen } from './component-document.js';
import type { ControlRow } from './editors.js';

export const CONFIRMATION_STORY = 'ConfirmAction';

const api = [
  ['authorityKey', 'string', '—', 'Stable identity binding confirmation to exactly one resource.'],
  ['label', 'string', '—', 'Action label shown before confirmation is requested.'],
  ['confirmLabel', 'string', '—', 'Explicit destructive action label shown when armed.'],
  ['question', 'string', '—', 'Concise consequence and confirmation prompt.'],
  ['enabled', 'boolean', 'true', 'Whether the initial action can be invoked.'],
  ['pendingLabel', 'string', 'Working…', 'Label shown while asynchronous confirmation is pending.'],
  ['cancelLabel', 'string', 'Cancel', 'Label that safely returns to the idle state.'],
  [
    'onConfirm',
    '(authorityKey: string) => void | Promise<void>',
    '—',
    'Runs after the separately armed destructive action.',
  ],
  [
    'onCancel',
    '(authorityKey: string) => void',
    '—',
    'Reports cancellation with the stable authority.',
  ],
] satisfies ReadonlyArray<readonly [string, string, string, string]>;

const apiRows: ControlRow[] = api.map(([name, type, defaultValue, note]) => ({
  prop: name,
  name,
  group: name.startsWith('on') ? 'interaction' : 'content',
  editor: name.startsWith('on') ? 'handler' : 'text',
  note,
  editable: false,
  values: [],
  default: defaultValue,
  type,
}));

/** A complete destructive flow: reveal authority, confirm separately, and report completion. */
export function ConfirmationStory() {
  const [removed, setRemoved] = useState(false);
  return (
    <Column gap={4} width="fill">
      <DocumentationSection title="Live specimens">
        <Column gap={2} width={{ chars: 76 }}>
          <Heading label="Destructive flow" scale="title" />
          <FieldSpecimen label="Idle">
            {removed ? (
              <InlineMessage label="Volume cache was removed." tone="positive" />
            ) : (
              <ConfirmAction
                authorityKey="volume:cache:generation-7"
                label="Remove volume"
                confirmLabel="Confirm removal"
                question="Remove volume cache generation 7? This cannot be undone."
                onConfirm={() => setRemoved(true)}
              />
            )}
          </FieldSpecimen>
          <FieldSpecimen label="Armed">
            <ConfirmAction
              authorityKey="volume:preview:generation-4"
              label="Preview confirmation"
              confirmLabel="Delete preview"
              pendingLabel="Deleting preview…"
              question="Delete preview volume? Its cached build data will be permanently deleted."
              onConfirm={() => new Promise<void>(() => {})}
            />
          </FieldSpecimen>
        </Column>
      </DocumentationSection>

      <DocumentationSection title="States">
        <Row gap={4} wrap width="fill">
          <FieldSpecimen label="Disabled">
            <ConfirmAction
              authorityKey="disabled-example"
              label="Removal unavailable"
              confirmLabel="Remove"
              question="Remove unavailable resource?"
              enabled={false}
              onConfirm={() => {}}
            />
          </FieldSpecimen>
        </Row>
      </DocumentationSection>

      <DocumentationSection title="Sizes">
        <Row gap={2} wrap>
          {(['small', 'medium', 'large'] as const).map((size) => (
            <ConfirmAction
              key={size}
              authorityKey={`${size}-example`}
              label={`${size[0].toUpperCase()}${size.slice(1)}`}
              confirmLabel={`Confirm ${size}`}
              question={`Confirm the ${size} action?`}
              size={size}
              onConfirm={() => {}}
            />
          ))}
        </Row>
        <Text
          label="Chrome is 28px, 36px, and 44px; every size retains at least a 44px interaction target."
          color="text-dim"
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="Behavior and accessibility">
        <Text
          label="Focus enters the trigger, then the destructive confirmation and Cancel. Changing authority closes stale confirmation. Pending work disables both decisions so it cannot run twice."
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="API">
        <ApiReference
          example={
            '<ConfirmAction authorityKey={volume.id} label="Remove" question="Remove volume?" onConfirm={remove} />'
          }
          rows={apiRows}
        />
      </DocumentationSection>
    </Column>
  );
}

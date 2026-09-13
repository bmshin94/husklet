import React from 'react';
import {
  Code,
  Column,
  Expander,
  FormControlLabel,
  Row,
  Select,
  Switch,
  Text,
} from '@husklet/react';
import {
  ApiReference,
  ComponentDocument,
  DocumentationSection,
  FieldSpecimen,
  SpecimenGrid,
} from './component-document.js';
import { rows } from './editors.js';

const shells = [
  { value: 'zsh', label: 'Z shell' },
  { value: 'bash', label: 'Bash' },
  { value: 'fish', label: 'Fish' },
];

export function SelectWorkbench() {
  const [value, setValue] = React.useState('zsh');
  const [enabled, setEnabled] = React.useState(true);
  const [wide, setWide] = React.useState(false);
  const [event, setEvent] = React.useState('Choose an option to inspect its value.');
  return (
    <ComponentDocument
      name="Select"
      summary="Select chooses one value from a short, stable set. Use labels people recognize and store the separate machine value."
    >
      <DocumentationSection title="Overview">
        <FieldSpecimen
          label="Default shell"
          helper={event}
          width={wide ? { chars: 42 } : { chars: 24 }}
        >
          <Select
            value={value}
            choices={shells}
            width={wide ? { chars: 42 } : { chars: 24 }}
            align="start"
            enabled={enabled}
            tooltip="Default shell"
            onChange={(report) => {
              const next = String(report.value);
              setValue(next);
              setEvent(
                `Selected · ${shells.find((choice) => choice.value === next)?.label ?? next}`,
              );
            }}
            onFocus={() => setEvent('Selector focused')}
          />
        </FieldSpecimen>
        <Code value={'<Select value={shell} choices={shells} onChange={setShell} />'} wrap />
      </DocumentationSection>
      <DocumentationSection title="Widths">
        <Column gap={2}>
          <FieldSpecimen label="Compact · 18ch" width={{ chars: 18 }}>
            <Select value="zsh" choices={shells} width={{ chars: 18 }} />
          </FieldSpecimen>
          <FieldSpecimen label="Default · 30ch" width={{ chars: 30 }}>
            <Select value="zsh" choices={shells} width={{ chars: 30 }} />
          </FieldSpecimen>
          <FieldSpecimen label="Full width">
            <Select value="zsh" choices={shells} width="fill" />
          </FieldSpecimen>
        </Column>
      </DocumentationSection>
      <DocumentationSection title="States">
        <Row gap={3} width="fill" wrap>
          <SelectStateSpecimens />
        </Row>
        <Text
          label="Keep the selected option visible; explain why an unavailable selector is disabled."
          color="text-dim"
          wrap
        />
      </DocumentationSection>
      <DocumentationSection title="Accessibility">
        <Text
          label="Pair the control with a visible field label. Option labels must be unique when spoken aloud, and keyboard focus must remain visible."
          wrap
        />
      </DocumentationSection>
      <DocumentationSection title="API">
        <ApiReference rows={rows('Select')} />
      </DocumentationSection>
      <Expander label="Playground" expanded={false} width="fill">
        <SpecimenGrid>
          <FormControlLabel label="Selector enabled" gap={2}>
            <Switch
              checked={enabled}
              tooltip="Selector enabled"
              onToggle={(report) => setEnabled(Boolean(report.value))}
            />
          </FormControlLabel>
          <FormControlLabel label="Use wide field" gap={2}>
            <Switch
              checked={wide}
              tooltip="Use wide field"
              onToggle={(report) => setWide(Boolean(report.value))}
            />
          </FormControlLabel>
        </SpecimenGrid>
      </Expander>
    </ComponentDocument>
  );
}

const stateSpecimens: Array<{
  label: string;
  helper: string;
  value: string;
  tooltip?: string;
  enabled?: boolean;
  tone?: 'danger';
  choices?: Array<{ value: string; label: string }>;
}> = [
  { label: 'Empty', helper: 'A choice is required', value: '' },
  {
    label: 'Focused',
    helper: 'Keyboard focus stays visible',
    value: 'zsh',
    tooltip: 'Focused shell selector',
  },
  { label: 'Selected', helper: 'Applies to new panes', value: 'zsh' },
  {
    label: 'Disabled',
    helper: 'Restart workspace to edit',
    value: 'bash',
    enabled: false,
  },
  { label: 'Invalid', helper: 'Choose a default shell', value: '', tone: 'danger' },
  {
    label: 'Long label',
    helper: 'Value truncates within the field',
    value: 'long',
    choices: [{ value: 'long', label: 'Remote development shell with workspace defaults' }],
  },
];

function SelectStateSpecimens() {
  return stateSpecimens.map((specimen) => (
    <FieldSpecimen
      key={specimen.label}
      label={specimen.label}
      helper={specimen.helper}
      width={{ chars: 30 }}
    >
      <Select
        value={specimen.value}
        choices={specimen.choices ?? shells}
        enabled={specimen.enabled}
        tone={specimen.tone}
        tooltip={specimen.tooltip}
        width={{ chars: 30 }}
      />
    </FieldSpecimen>
  ));
}

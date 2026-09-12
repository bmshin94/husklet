import React from 'react';
import { Code, Expander, Radio, RadioGroup, Row, Text } from '@husklet/react';
import {
  ApiReference,
  ComponentDocument,
  DocumentationSection,
  FieldSpecimen,
} from './component-document.js';
import { rows } from './editors.js';

type Shell = 'zsh' | 'bash' | 'fish';

const SHELLS: ReadonlyArray<{ value: Shell; label: string; detail: string }> = [
  { value: 'zsh', label: 'Z shell', detail: 'Default · interactive' },
  { value: 'bash', label: 'Bash', detail: 'Portable scripts' },
  { value: 'fish', label: 'Fish', detail: 'Friendly defaults' },
];

export function RadioWorkbench() {
  const [selected, setSelected] = React.useState<Shell>('zsh');
  const [showCode, setShowCode] = React.useState(false);

  function choose(option: Shell, value: unknown) {
    if (value === null || Boolean(value)) setSelected(option);
  }

  return (
    <ComponentDocument
      name="Radio"
      summary="Radio selects one option from a visible set. The label and indicator form one native target."
    >
      <DocumentationSection title="Live specimen">
        <FieldSpecimen
          label="Default shell"
          helper="Arrow keys move selection; the result updates immediately."
          width={{ chars: 36 }}
        >
          <RadioGroup gap={1} tooltip="Default shell" width="fill">
            {SHELLS.map((shell) => (
              <Radio
                key={shell.value}
                label={`${shell.label} · ${shell.detail}`}
                checked={selected === shell.value}
                onToggle={(report) => choose(shell.value, report.value)}
              />
            ))}
          </RadioGroup>
        </FieldSpecimen>
        <Text label={`Current value · ${selected}`} color="text-dim" />
      </DocumentationSection>

      <DocumentationSection title="States">
        <Row gap={3} width="fill" wrap>
          <FieldSpecimen label="Unchecked" helper="Available, not selected" width={{ chars: 28 }}>
            <Radio label="Automatic" checked={false} />
          </FieldSpecimen>
          <FieldSpecimen label="Checked" helper="The group’s current value" width={{ chars: 28 }}>
            <Radio label="Automatic" checked />
          </FieldSpecimen>
          <FieldSpecimen
            label="Disabled · unchecked"
            helper="Unavailable by workspace policy"
            width={{ chars: 28 }}
          >
            <Radio label="Automatic" checked={false} enabled={false} />
          </FieldSpecimen>
          <FieldSpecimen
            label="Disabled · checked"
            helper="A retained value that cannot be changed"
            width={{ chars: 28 }}
          >
            <Radio label="Automatic" checked enabled={false} />
          </FieldSpecimen>
        </Row>
      </DocumentationSection>

      <DocumentationSection title="Size and spacing">
        <Text
          label="Radio has one compact native indicator size and a full label target. Keep 8px between options and at least 44px around the group when it sits among other controls; do not shrink the indicator for dense forms."
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="Behavior and accessibility">
        <Text
          label="Keep two or more options in one RadioGroup and one controlled checked value. Tab enters the group once; arrow keys move focus and selection among enabled options; Space selects the focused option. Every option needs a distinct visible label."
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="Implementation">
        <Expander
          label="Show controlled example"
          expanded={showCode}
          width="fill"
          onExpand={(report) => setShowCode(Boolean(report.value))}
        >
          <Code
            value={
              '<RadioGroup>\n' +
              '  <Radio label="Z shell" checked={shell === "zsh"} onToggle={() => setShell("zsh")} />\n' +
              '  <Radio label="Bash" checked={shell === "bash"} onToggle={() => setShell("bash")} />\n' +
              '</RadioGroup>'
            }
            wrap
          />
        </Expander>
      </DocumentationSection>

      <DocumentationSection title="API">
        <ApiReference rows={rows('Radio')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

import React from 'react';
import type { ActivationReport, ColumnSpec, SelectionReport } from '@husklet/react';
import { Button, Code, Column, Heading, InlineMessage, TestReportView, Text } from '@husklet/react';
import {
  ApiReference,
  ComponentDocument,
  DocumentationSection,
  FieldSpecimen,
} from './component-document.js';
import { rows } from './editors.js';
import { LargeRecordSource, type SourceSender } from './large-table.js';

export const TEST_REPORT_STORY = 'Inspect test report';
export const TEST_REPORT_SOURCE = 103;
export const TEST_REPORT_ROWS = 10_000;
export const TEST_REPORT_SCHEMA: readonly ColumnSpec[] = Object.freeze([
  { key: 'id', title: 'Case', width: { chars: 9 }, identity: true },
  { key: 'name', title: 'Test', width: 'fill', importance: 'optional' },
  { key: 'suite', title: 'Suite', width: { chars: 12 }, importance: 'optional' },
  { key: 'duration', title: 'Duration', width: { chars: 9 }, align: 'end', importance: 'optional' },
  { key: 'state', title: 'Outcome', width: { chars: 10 } },
  { key: 'source', title: 'Source', width: { chars: 18 }, importance: 'optional' },
  { key: 'detail', title: 'Detail', width: { chars: 20 }, importance: 'optional' },
]);

export class TestReportSource extends LargeRecordSource {
  constructor(send: SourceSender = async () => {}) {
    super(send, TEST_REPORT_SOURCE, TEST_REPORT_ROWS);
  }

  override row(index: number) {
    const status = index % 11 === 0 ? 'failed' : index % 7 === 0 ? 'skipped' : 'passed';
    const hasSource = index % 5 !== 0;
    return {
      key: index,
      cells: [
        { Text: `case-${index}` },
        { Text: `preserves workspace contract ${index}` },
        { Text: index % 2 ? 'integration' : 'unit' },
        { Number: index % 997 },
        {
          Badge: {
            label: status,
            tone: status === 'failed' ? 'Danger' : status === 'skipped' ? 'Warning' : 'Positive',
          },
        },
        { Text: hasSource ? `file:///workspace/tests/case-${index}.ts:${index + 1}` : '' },
        {
          Text:
            status === 'failed'
              ? 'Expected the workspace to remain ready after reconnect.'
              : status === 'skipped'
                ? 'Requires an integration fixture.'
                : '',
        },
      ],
    };
  }
}

function reportIdentity(report: ActivationReport | SelectionReport): string | null {
  const row = report.collection?.rows[0];
  return row ? `case-${String(row.id)}` : null;
}

function sourceFor(identity: string | null): string | null {
  if (!identity) return null;
  const index = Number(identity.slice('case-'.length));
  return Number.isSafeInteger(index) && index % 5 !== 0
    ? `file:///workspace/tests/${identity}.ts:${index + 1}`
    : null;
}

export function TestReportStory() {
  return (
    <Column gap={2} grow>
      <Heading label="CI test report" scale="title" />
      <Text
        label={`${TEST_REPORT_ROWS.toLocaleString()} source-backed cases · 128 rows per window`}
      />
      <TestReportView source={TEST_REPORT_SOURCE} schema={[...TEST_REPORT_SCHEMA]} grow />
    </Column>
  );
}

export function TestReportWorkbench({ source }: { source?: TestReportSource } = {}) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [activated, setActivated] = React.useState<string | null>(null);
  const location = sourceFor(activated);
  React.useEffect(() => {
    void source?.publish();
  }, [source]);
  return (
    <ComponentDocument
      name="Test Report View"
      summary="TestReportView inspects large test runs through bounded source windows while preserving each producer-owned case identity."
    >
      <DocumentationSection title="Interactive report">
        <TestReportView
          source={TEST_REPORT_SOURCE}
          schema={[...TEST_REPORT_SCHEMA]}
          width="fill"
          height={{ step: 72 }}
          onSelect={(report) => setSelected(reportIdentity(report))}
          onActivate={(report) => setActivated(reportIdentity(report))}
        />
        <Text
          label={selected ? `Selected ${selected}` : 'Select a full row with pointer or Space.'}
          color="text-dim"
        />
        <InlineMessage
          label={
            activated
              ? `Activated immutable case ${activated}`
              : 'Press Enter or double-click a row to activate the same immutable case identity.'
          }
        />
        {location ? (
          <Button label={`Open ${location}`} size="small" variant="outline" />
        ) : activated ? (
          <Text label="This case has no source location." color="text-dim" />
        ) : null}
      </DocumentationSection>
      <DocumentationSection title="Windowing">
        <FieldSpecimen
          label={`${TEST_REPORT_ROWS.toLocaleString()} logical cases`}
          helper="The host requests and retains at most 128 rows around the visible viewport."
        >
          <Code value={`source=${TEST_REPORT_SOURCE} · row keys: case-0…case-9999`} wrap />
        </FieldSpecimen>
      </DocumentationSection>
      <DocumentationSection title="Keyboard and accessibility">
        <Text
          label="The grid is one Tab stop. Arrow keys move and reveal rows, Space selects the current row, and Enter activates it. Optional source and bounded detail move into the narrow Details disclosure."
          wrap
        />
      </DocumentationSection>
      <DocumentationSection title="API">
        <ApiReference rows={rows('TestReportView')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

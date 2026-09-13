import React from 'react';
import { Code, Column, Heading, InlineMessage, Select, TestReportView, Text } from '@husklet/react';
import {
  ApiReference,
  ComponentDocument,
  DocumentationSection,
  FieldSpecimen,
  SpecimenGrid,
} from './component-document.js';
import { rows } from './editors.js';
export const TEST_REPORT_STORY = 'Inspect test report';
export const CASE_LIMIT = 256;
export const FAILURE_LIMIT = 512;
type TestCase = {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  failure?: unknown;
};
export function boundedCases(cases: readonly unknown[]): string {
  const clean = (value: unknown): string => String(value).replace(/[\t\r\n]/g, ' ');
  return cases
    .filter((entry): entry is TestCase => {
      if (entry === null || typeof entry !== 'object') return false;
      const { suite, name, status, durationMs } = entry as Record<string, unknown>;
      return (
        typeof suite === 'string' &&
        Boolean(suite.trim()) &&
        typeof name === 'string' &&
        Boolean(name.trim()) &&
        (status === 'passed' || status === 'failed' || status === 'skipped') &&
        Number.isSafeInteger(durationMs) &&
        Number(durationMs) >= 0
      );
    })
    .slice(0, CASE_LIMIT)
    .map(
      ({ suite, name, status, durationMs, failure = '' }) =>
        `${clean(suite)}\t${clean(name)}\t${status}\t${durationMs}\t${[...clean(failure)].slice(0, FAILURE_LIMIT).join('')}`,
    )
    .join('\n');
}
export function TestReportStory() {
  const value = boundedCases([
    { suite: 'auth', name: 'accepts valid token', status: 'passed', durationMs: 14 },
    {
      suite: 'auth',
      name: 'rejects expired token',
      status: 'failed',
      durationMs: 8,
      failure: 'expected 401, received 200',
    },
    {
      suite: 'storage',
      name: 'recovers journal',
      status: 'skipped',
      durationMs: 0,
      failure: 'requires integration fixture',
    },
  ]);
  return (
    <Column gap={2} grow={true}>
      <Heading label={'CI test report'} scale={'title'} />
      <Text
        label={'Suite, case, status, duration, and bounded failure detail remain selectable.'}
      />
      <TestReportView value={value} tone={'warning'} grow={true} />
      <InlineMessage label={`Showing 3 of at most ${CASE_LIMIT} cases`} />
    </Column>
  );
}

const mixedReport = boundedCases([
  { suite: 'auth', name: 'accepts valid token', status: 'passed', durationMs: 14 },
  {
    suite: 'auth',
    name: 'rejects expired token',
    status: 'failed',
    durationMs: 8,
    failure: 'expected 401, received 200',
  },
  {
    suite: 'storage',
    name: 'recovers journal',
    status: 'skipped',
    durationMs: 0,
    failure: 'requires integration fixture',
  },
]);

export function TestReportWorkbench() {
  const [mode, setMode] = React.useState<'mixed' | 'passed' | 'failed' | 'skipped'>('mixed');
  const selected =
    mode === 'mixed'
      ? mixedReport
      : mode === 'passed'
        ? 'unit\tsaves settings\tpassed\t12\t'
        : mode === 'failed'
          ? 'integration\treconnects after restart\tfailed\t83\texpected ready, received offline'
          : 'release\tsigns macOS bundle\tskipped\t0\trequires signing identity';
  return (
    <ComponentDocument
      name="Test Report View"
      summary="TestReportView presents bounded test outcomes with status, duration, and failure detail that stays readable without relying on color."
    >
      <DocumentationSection title="Overview">
        <Select
          value={mode}
          choices={[
            { value: 'mixed', label: 'Mixed outcomes' },
            { value: 'passed', label: 'Passed' },
            { value: 'failed', label: 'Failed' },
            { value: 'skipped', label: 'Skipped' },
          ]}
          tooltip="Visible test outcome"
          onChange={({ value }) =>
            setMode((value ?? 'mixed') as 'mixed' | 'passed' | 'failed' | 'skipped')
          }
        />
        <Text label={`Showing ${mode} outcomes`} color="text-dim" />
        <TestReportView value={selected} width="fill" />
        <Code value={'<TestReportView value={boundedReport} width="fill" />'} wrap />
      </DocumentationSection>

      <DocumentationSection title="States">
        <SpecimenGrid>
          <FieldSpecimen label="Passed" helper="A completed case keeps its duration visible.">
            <TestReportView value={'unit\tsaves settings\tpassed\t12\t'} width="fill" />
          </FieldSpecimen>
          <FieldSpecimen
            label="Failed"
            helper="Failure detail remains selectable and wraps in place."
          >
            <TestReportView
              value={
                'integration\treconnects after restart\tfailed\t83\texpected ready, received offline'
              }
              tone="danger"
              width="fill"
            />
          </FieldSpecimen>
          <FieldSpecimen label="Skipped" helper="A skipped reason stays distinct from failure.">
            <TestReportView
              value={'release\tsigns macOS bundle\tskipped\t0\trequires signing identity'}
              tone="warning"
              width="fill"
            />
          </FieldSpecimen>
        </SpecimenGrid>
      </DocumentationSection>

      <DocumentationSection title="Bounds and accessibility">
        <Text
          label={`Serialize at most ${CASE_LIMIT} cases and ${FAILURE_LIMIT} characters of failure detail per case. Every outcome includes status text and a distinct symbol.`}
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="API">
        <ApiReference rows={rows('TestReportView')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

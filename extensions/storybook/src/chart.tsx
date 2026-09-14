import React from 'react';
import { Chart, Column, Row, Text } from '@husklet/react';

import { ComponentDocument, DocumentationSection, SpecimenGrid } from './component-document.js';

const buildDuration = [18, 22, 19, 31, 28, 35, 42, 39];
const queueDepth = [3, 8, 5, 13, 9, 16, 11, 6];

/** The focused Chart page: real numeric input, semantic tones, and scale behaviour. */
export function ChartWorkbench() {
  return (
    <ComponentDocument
      name="Chart"
      summary="A compact, theme-aware plot for ordered numeric samples."
    >
      <DocumentationSection title="Overview">
        <Column gap={2}>
          <Chart label="Build duration" series={buildDuration} tone="accent" height={30} />
          <Row gap={1} align="center">
            <Text label="18 ms" color="text-dim" />
            <Text label="Latest 39 ms" grow />
            <Text label="Peak 42 ms" color="text-dim" />
          </Row>
        </Column>
      </DocumentationSection>
      <SpecimenGrid>
        <DocumentationSection title="Semantic tone">
          <Chart label="Queue depth" series={queueDepth} tone="warning" height={22} />
        </DocumentationSection>
        <DocumentationSection title="Constant values">
          <Chart label="Healthy replicas" series={[4, 4, 4, 4, 4]} tone="positive" height={22} />
        </DocumentationSection>
      </SpecimenGrid>
      <DocumentationSection title="Usage">
        <Text
          label={'<Chart label="Build duration" series={[18, 22, 19, 31]} tone="accent" />'}
          wrap
        />
      </DocumentationSection>
    </ComponentDocument>
  );
}

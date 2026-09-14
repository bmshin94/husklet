import React from 'react';
import {
  Badge,
  Card,
  CardContent,
  Column,
  Responsive,
  Row,
  Search,
  Select,
  Text,
} from '@husklet/react';

import { ApiReference, ComponentDocument, DocumentationSection } from './component-document.js';
import { rows } from './editors.js';

export function ResponsiveWorkbench() {
  return (
    <ComponentDocument
      name="Responsive"
      summary="Author compact and wide layouts explicitly; the host exposes only the branch selected by its allocated width."
    >
      <DocumentationSection title="Alternate layouts">
        <Responsive alternate breakpoint={720} width="fill">
          <Column gap={2} width="fill">
            <Badge label="Compact · below 720px" tone="accent" />
            <Search placeholder="Search components" width="fill" />
            <Row gap={2} align="center" width="fill">
              <Text label="Section" color="text-dim" />
              <Select
                width={{ minimum: { chars: 14 }, maximum: { chars: 24 } }}
                value="all"
                choices={[{ value: 'all', label: 'All families' }]}
              />
            </Row>
          </Column>
          <Row gap={2} width="fill" align="center">
            <Badge label="Wide · 720px and above" tone="accent" />
            <Search placeholder="Search components" grow />
            <Select
              value="all"
              width={{ minimum: { chars: 18 } }}
              choices={[{ value: 'all', label: 'All families' }]}
            />
          </Row>
        </Responsive>
      </DocumentationSection>
      <DocumentationSection title="Behavior">
        <Card variant="outline" width="fill">
          <CardContent gap={1}>
            <Text label="Child 1 is the compact layout; child 2 is the wide layout." />
            <Text
              label="Resizing is deterministic. The inactive branch is hidden from drawing, focus, and accessibility traversal."
              color="text-dim"
              wrap
            />
            <Text
              label="Compact label-and-control toolbars keep an 8px gap so labels remain distinct when the host narrows the surface."
              color="text-dim"
              wrap
            />
          </CardContent>
        </Card>
      </DocumentationSection>
      <DocumentationSection title="API">
        <ApiReference rows={rows('Responsive')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

import React from 'react';
import { Card, CardContent, CardHeader, Splitter, Text } from '@husklet/react';
import { ComponentDocument, DocumentationSection } from './component-document.js';

export function SplitterWorkbench() {
  const [position, setPosition] = React.useState(160);
  return (
    <ComponentDocument
      name="Splitter"
      summary="Splitter gives adjacent panes an obvious, keyboard-accessible resizing boundary."
    >
      <DocumentationSection title="Overview">
        <Text label={`Leading pane · ${position}px`} color="text-dim" />
        <Splitter
          orientation="horizontal"
          position={position}
          height={{ step: 60 }}
          width="fill"
          onChange={(event) => setPosition(Number(event.value))}
        >
          <Card label="Leading pane" width="fill" height="fill">
            <CardHeader label="Navigation" />
            <CardContent>
              <Text label="Drag to resize." wrap />
            </CardContent>
          </Card>
          <Card label="Trailing pane" width="fill" height="fill">
            <CardHeader label="Workspace" />
            <CardContent>
              <Text label="Position remains stable." wrap />
            </CardContent>
          </Card>
        </Splitter>
      </DocumentationSection>
    </ComponentDocument>
  );
}

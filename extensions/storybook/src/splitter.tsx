import React from 'react';
import { Card, CardContent, CardHeader, Code, Splitter, Text } from '@husklet/react';
import { ApiReference, ComponentDocument, DocumentationSection } from './component-document.js';
import { rows } from './editors.js';

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
          height={{ step: 44 }}
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
        <Code
          value={
            '<Splitter orientation="horizontal" position={position}\n' +
            '  onChange={(event) => setPosition(Number(event.value))}>\n' +
            '  <Navigation />\n' +
            '  <Workspace />\n' +
            '</Splitter>'
          }
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="Vertical orientation">
        <Text
          label="Use a vertical splitter when the secondary pane belongs above or below the primary workspace."
          color="text-dim"
          wrap
        />
        <Splitter orientation="vertical" position={88} height={{ step: 52 }} width="fill">
          <Card label="Upper pane" width="fill" height="fill">
            <CardHeader label="Editor" />
            <CardContent>
              <Text label="Primary work remains visible." wrap />
            </CardContent>
          </Card>
          <Card label="Lower pane" width="fill" height="fill">
            <CardHeader label="Terminal" />
            <CardContent>
              <Text label="Output can be resized without changing layout mode." wrap />
            </CardContent>
          </Card>
        </Splitter>
      </DocumentationSection>

      <DocumentationSection title="Interaction">
        <Text
          label="Drag the 8px divider with a pointer. Tab focuses it; arrow keys resize one step, and Home or End moves to an edge. Keep position in state when the split must survive rerenders."
          wrap
        />
      </DocumentationSection>

      <DocumentationSection title="API">
        <ApiReference rows={rows('Splitter')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

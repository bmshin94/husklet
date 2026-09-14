import React from 'react';
import { Code, Column, NavigationMenu, NavigationMenuItem, Text } from '@husklet/react';
import { ApiReference, ComponentDocument, DocumentationSection } from './component-document.js';
import { rows } from './editors.js';

const destinations = [
  { value: 'workspace', label: 'Workspace', icon: 'view-grid-symbolic' },
  { value: 'extensions', label: 'Extensions', icon: 'list-add-symbolic' },
  { value: 'terminals', label: 'Terminals', icon: 'utilities-terminal-symbolic' },
] as const;

export function NavigationMenuItemWorkbench() {
  const [selected, setSelected] = React.useState('workspace');
  return (
    <ComponentDocument
      name="NavigationMenuItem"
      summary="Navigation menu items switch places. They are compact selectable rows, not action buttons."
    >
      <DocumentationSection title="Destination states">
        <Column width={{ chars: 30 }} align="start">
          <NavigationMenu width="fill" gap={0}>
            {destinations.map((destination) => (
              <NavigationMenuItem
                key={destination.value}
                label={destination.label}
                icon={destination.icon}
                selected={selected === destination.value}
                variant={selected === destination.value ? 'filled' : 'ghost'}
                tone={selected === destination.value ? 'accent' : 'neutral'}
                tooltip={`Open ${destination.label}`}
                onInvoke={() => setSelected(destination.value)}
              />
            ))}
            <NavigationMenuItem
              label="Unavailable destination"
              icon="changes-prevent-symbolic"
              enabled={false}
              variant="ghost"
              tone="neutral"
            />
          </NavigationMenu>
        </Column>
        <Text
          label={`Current destination · ${destinations.find(({ value }) => value === selected)?.label}`}
          color="text-dim"
        />
        <Code
          value={'<NavigationMenuItem label="Extensions" selected={page === "extensions"} />'}
          wrap
        />
      </DocumentationSection>
      <DocumentationSection title="Usage boundary">
        <Column gap={1}>
          <Text label="Use one selected row for the current destination." />
          <Text
            label="Use Button or IconButton for commands, and require confirmation for destructive work."
            color="text-dim"
            wrap
          />
        </Column>
      </DocumentationSection>
      <DocumentationSection title="Accessibility">
        <Text
          label="Each available destination is keyboard focusable, and focus remains visibly distinct from the selected destination."
          wrap
        />
      </DocumentationSection>
      <DocumentationSection title="API">
        <ApiReference rows={rows('NavigationMenuItem')} />
      </DocumentationSection>
    </ComponentDocument>
  );
}

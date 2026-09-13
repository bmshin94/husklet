// Paint through the framework-neutral client before loading the component catalogue.

import { bootstrapSurface, connect } from '@husklet/client';
import type { RowRequest, RowWindow } from '@husklet/client';
import type { InterfaceSourceMutation, RenderHandle } from '@husklet/react';

type RowSource = { answer(request: unknown): RowWindow | null; publish(): Promise<unknown> };
type SourceSender = (
  _call: string,
  argument: { mutation: InterfaceSourceMutation },
) => Promise<void>;
type SourceConstructor = new (send: SourceSender) => RowSource;

let surface: RenderHandle;
let sources: RowSource[] = [];
const session = await connect({
  onRows(request, channel) {
    const window = sources.map((source) => source.answer(request)).find(Boolean);
    session.answer(channel, window ?? emptyWindow(request));
  },
});

function emptyWindow(request: RowRequest): RowWindow {
  return {
    source: request.source,
    version: request.version,
    request: request.id,
    range: request.range,
    rows: [],
  };
}
const bootstrap = await bootstrapSurface(session, {
  title: 'Components',
  label: 'Loading component playground…',
  primary: true,
});
const [React, react, app, large, tests, events, keyValues, files] = await Promise.all([
  import('react').then((module) => module.default),
  import('@husklet/react'),
  import('./app.js'),
  import('./large-table.js'),
  import('./test-report.js'),
  import('./event-stream.js'),
  import('./key-value-inspector.js'),
  import('./file-browser.js'),
]);
const send: SourceSender = (_call, argument) => surface.source(argument.mutation);
const source = new (large.LargeRecordSource as unknown as SourceConstructor)(send);
const testSource = new (tests.TestReportSource as unknown as SourceConstructor)(send);
const timeline = new (events.TimelineSource as unknown as SourceConstructor)(send);
const keyValueSource = new (keyValues.KeyValueSource as unknown as SourceConstructor)(send);
const fileSource = new (files.FileSource as unknown as SourceConstructor)(send);
sources = [source, testSource, timeline, keyValueSource, fileSource];
const Playground = app.Playground as unknown as React.ComponentType<Record<string, unknown>>;
surface = react.render(
  React.createElement(Playground, {
    largeSource: source,
    testSource,
    timelineSource: timeline,
    keyValueSource,
    fileSource,
    initialStory: process.env.HUSKLET_STORYBOOK_STORY,
  }),
  session,
  { title: 'Components', bootstrap },
);
await surface.flush();
await Promise.all(sources.map((sourceModel) => sourceModel.publish()));
await surface.flush();

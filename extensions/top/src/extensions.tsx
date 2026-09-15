import React from 'react';
import { PROTOCOL } from '@husklet/client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Column,
  Container,
  ConfirmAction,
  Entry,
  Expander,
  FormControl,
  FormControlLabel,
  Heading,
  InlineButton,
  InlineMessage,
  Progress,
  RecoveryState,
  Search,
  ResourceState,
  Responsive,
  Row,
  Scroll,
  Select,
  Separator,
  Spacer,
  Spinner,
  Switch,
  Text,
  ToggleButton,
  ToggleButtonGroup,
  type ExtensionAcquisitionStatus,
  type ExtensionCapability,
  type ExtensionCatalogue,
  type ExtensionCatalogueEntry,
  type ExtensionPaneProvider,
  type ExtensionSummary,
  type ContainerGrant,
  type ContainerSelector,
  type ImageGrant,
  type ImageSelector,
  type NetworkGrant,
  type NetworkSelector,
  type VolumeGrant,
  type VolumeSelector,
  type FilesystemGrant,
  type FilesystemSelector,
  type WorkspaceEnvironmentGrant,
  type CredentialGrant,
  type WorkspaceApi,
} from '@husklet/react';

type Change = { value?: unknown; expanded?: unknown };
type ExtensionMode = 'installed' | 'discover';
type LifecycleAction = 'enable' | 'disable' | 'retry' | 'remove';
type LifecycleState = { action: LifecycleAction; name: string };
type ProviderFailure = { key: string; detail: string; retry: boolean };
export type CatalogueFilter =
  'discover' | 'all' | 'available' | 'installed' | 'updates' | 'incompatible';
export type InstalledFilter = 'all' | 'running' | 'faulted' | 'updates' | 'disabled';
type ImageVerb = 'read' | 'use' | 'pull' | 'remove';
const IMAGE_VERBS: { key: ImageVerb; label: string }[] = [
  { key: 'read', label: 'View image' },
  { key: 'use', label: 'Use image for new containers' },
  { key: 'pull', label: 'Pull image' },
  { key: 'remove', label: 'Remove image' },
];

function imageCapability(verb: ImageVerb): ExtensionCapability {
  switch (verb) {
    case 'read':
      return 'images:read';
    case 'use':
      return 'containers:create';
    case 'pull':
      return 'images:pull';
    case 'remove':
      return 'images:remove';
  }
}

const COPY_WIDTH = { maximum: { chars: 54 } } as const;
const PAGE_WIDTH = { maximum: { chars: 110 } } as const;
const CATALOGUE_PAGE_SIZE = 12;
const INSTALLED_PAGE_SIZE = 12;
const FILESYSTEM_VERBS = [
  { key: 'read', label: 'View contents', meaning: 'read' },
  { key: 'write', label: 'Modify existing contents', meaning: 'write' },
  { key: 'create', label: 'Create new entries', meaning: 'create' },
  { key: 'delete', label: 'Delete entries', meaning: 'delete' },
  { key: 'rename', label: 'Rename or move entries', meaning: 'rename' },
] as const;
type FilesystemVerb = (typeof FILESYSTEM_VERBS)[number]['key'];

function withCapability(
  current: ExtensionCapability[],
  capability: ExtensionCapability,
  enabled: boolean,
) {
  return enabled
    ? [...new Set([...current, capability])]
    : current.filter((item) => item !== capability);
}

function emptyFilesystemGrant(): Required<FilesystemGrant> {
  return { read: [], write: [], create: [], delete: [], rename: [] };
}

function isInstalledCandidateUnchanged(
  candidate: ExtensionAcquisitionStatus['candidate'],
): boolean {
  return Boolean(
    candidate?.installed_image_digest &&
    candidate.installed_image_digest === candidate.image_digest,
  );
}

function filesystemRoots(grant: FilesystemGrant, verb: FilesystemVerb): FilesystemSelector[] {
  return grant[verb] ?? [];
}

function filesystemSelectorKey(selector: FilesystemSelector): string {
  return 'exact' in selector ? `exact:${selector.exact}` : `subtree:${selector.subtree}`;
}

function filesystemConsentLabel(selector: FilesystemSelector, action: string): string {
  return 'exact' in selector
    ? `Only this file · ${action.toLocaleLowerCase()} · ${selector.exact}`
    : `This folder subtree · ${action.toLocaleLowerCase()} · ${selector.subtree || 'workspace root'}/`;
}

function filesystemGrantCount(grant: FilesystemGrant): number {
  return FILESYSTEM_VERBS.reduce((count, { key }) => count + filesystemRoots(grant, key).length, 0);
}

function catalogueCompatibility(entry: ExtensionCatalogueEntry, architecture: string) {
  if (entry.protocol !== undefined && entry.protocol !== PROTOCOL) {
    return {
      compatible: false,
      label: `Incompatible · requires protocol ${entry.protocol}; this client uses ${PROTOCOL}`,
    } as const;
  }
  if (entry.architectures && architecture && !entry.architectures.includes(architecture)) {
    return {
      compatible: false,
      label: `Incompatible · supports ${entry.architectures.join(', ')}; workspace is ${architecture}`,
    } as const;
  }
  if (entry.protocol === undefined && entry.architectures === undefined) {
    return { compatible: null, label: 'Compatibility not declared' } as const;
  }
  if (entry.architectures && !architecture) {
    return { compatible: null, label: 'Checking workspace architecture compatibility…' } as const;
  }
  return {
    compatible: true,
    label: `Compatible${entry.protocol === undefined ? '' : ` · protocol ${entry.protocol}`}${entry.architectures === undefined ? '' : ` · ${architecture}`}`,
  } as const;
}

export function catalogueTrust(entry: ExtensionCatalogueEntry) {
  return entry.publisher_verified
    ? { label: 'Verified publisher', tone: 'positive' as const }
    : { label: 'Community publisher', tone: 'warning' as const };
}

export function staleCatalogueExpectation(entry: ExtensionCatalogueEntry | null) {
  return entry ? { ...entry, publisher_verified: false } : entry;
}

function isVerifiedFirstPartyCatalogueEntry(entry: ExtensionCatalogueEntry | null): boolean {
  return Boolean(entry?.publisher_verified === true && entry.publisher === 'Husklet');
}

export function catalogueCandidateMismatch(
  entry: Pick<ExtensionCatalogueEntry, 'id' | 'version' | 'reference'> | null,
  candidate: { name: string; version: string } | null | undefined,
  acquiredReference?: string,
) {
  if (!entry || !candidate) return '';
  if (acquiredReference !== undefined && acquiredReference !== entry.reference)
    return `Catalogue image changed: expected the selected image reference, but the acquisition completed for a different reference.`;
  if (candidate.name !== entry.id)
    return `Catalogue identity changed: expected ${entry.id}, but the inspected image declares ${candidate.name}.`;
  if (candidate.version !== entry.version)
    return `Catalogue version changed: expected ${entry.version}, but the inspected image declares ${candidate.version}.`;
  return '';
}

export function compactImageReference(reference: string) {
  const separator = reference.lastIndexOf('@');
  if (separator < 0) return reference;
  const name = reference.slice(0, separator);
  const digest = reference.slice(separator + 1);
  return `${name} · ${compactDigest(digest)}`;
}

function compareCatalogueEntries(left: ExtensionCatalogueEntry, right: ExtensionCatalogueEntry) {
  const leftKey = `${left.title.toLowerCase()}\0${left.id.toLowerCase()}`;
  const rightKey = `${right.title.toLowerCase()}\0${right.id.toLowerCase()}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function catalogueEntryMatches(
  entry: ExtensionCatalogueEntry,
  installed: ExtensionSummary[],
  architecture: string,
  query: string,
  filter: CatalogueFilter,
  category: string,
) {
  const installedExtension = installed.find((extension) => extension.name === entry.id);
  const updateAvailable = Boolean(
    installedExtension && catalogueUpdateAvailable(entry, installedExtension),
  );
  const incompatible = catalogueCompatibility(entry, architecture).compatible === false;
  const statusMatches =
    (filter === 'discover' && (!installedExtension || updateAvailable)) ||
    filter === 'all' ||
    (filter === 'available' && !installedExtension) ||
    (filter === 'installed' && Boolean(installedExtension)) ||
    (filter === 'updates' && updateAvailable) ||
    (filter === 'incompatible' && incompatible);
  if (!statusMatches) return false;
  if (category && !(entry.categories ?? []).includes(category)) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    entry.title,
    entry.id,
    entry.publisher,
    entry.description,
    entry.version,
    entry.source,
    entry.reference,
    ...(entry.categories ?? []),
    ...(entry.architectures ?? []),
    entry.publisher_verified ? 'verified publisher' : 'community publisher',
  ].some((value) => value.toLocaleLowerCase().includes(needle));
}

export function filterCatalogueEntries(
  entries: ExtensionCatalogueEntry[],
  installed: ExtensionSummary[],
  architecture: string,
  query: string,
  filter: CatalogueFilter,
  category = '',
) {
  return entries
    .filter((entry) =>
      catalogueEntryMatches(entry, installed, architecture, query, filter, category),
    )
    .sort(compareCatalogueEntries);
}

function installedUpdate(
  extension: ExtensionSummary,
  catalogue: ExtensionCatalogueEntry[],
): ExtensionCatalogueEntry | undefined {
  return catalogue.find(
    (entry) => entry.id === extension.name && catalogueUpdateAvailable(entry, extension),
  );
}

/** A pinned catalogue digest is part of release identity, even when a daily
 * development build intentionally keeps the manifest version unchanged. */
export function catalogueUpdateAvailable(
  entry: ExtensionCatalogueEntry,
  installed: ExtensionSummary,
): boolean {
  if (entry.id !== installed.name) return false;
  if (newerVersion(entry.version, installed.version)) return true;
  if (entry.version !== installed.version) return false;
  const match = /@((?:sha256):[0-9a-fA-F]{64})$/.exec(entry.reference);
  const installedDigest = /^sha256:[0-9a-fA-F]{64}$/.test(installed.image_digest)
    ? installed.image_digest.toLowerCase()
    : null;
  return Boolean(match && installedDigest && match[1].toLowerCase() !== installedDigest);
}

function installedPriority(
  extension: ExtensionSummary,
  catalogue: ExtensionCatalogueEntry[],
): number {
  if (extension.status.startsWith('fault:')) return 0;
  if (installedUpdate(extension, catalogue)) return 1;
  if (!extension.enabled || extension.status === 'standby') return 2;
  if (extension.enabled) return 3;
  return 4;
}

export function installedExtensionNeedsAttention(
  extension: ExtensionSummary,
  catalogue: ExtensionCatalogueEntry[],
): boolean {
  return extension.status.startsWith('fault:') || Boolean(installedUpdate(extension, catalogue));
}

export function filterInstalledExtensions(
  extensions: ExtensionSummary[],
  catalogue: ExtensionCatalogueEntry[],
  query: string,
  filter: InstalledFilter,
) {
  const needle = query.trim().toLocaleLowerCase();
  return extensions
    .filter((extension) => {
      const faulted = extension.status.startsWith('fault:');
      const update = Boolean(installedUpdate(extension, catalogue));
      const disabled = !extension.enabled || extension.status === 'standby';
      const statusMatches =
        filter === 'all' ||
        (filter === 'running' && extension.enabled && !faulted) ||
        (filter === 'faulted' && faulted) ||
        (filter === 'updates' && update) ||
        (filter === 'disabled' && disabled);
      if (!statusMatches) return false;
      if (!needle) return true;
      return [
        extension.name,
        extension.status,
        ...(extension.pane_providers ?? []).flatMap((provider) => [provider.id, provider.title]),
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    })
    .sort((left, right) => {
      const priority = installedPriority(left, catalogue) - installedPriority(right, catalogue);
      if (priority !== 0) return priority;
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
}

function FilesystemConsent({
  requested,
  granted,
  onChange,
  onCapabilityChange,
}: {
  requested: FilesystemGrant;
  granted: FilesystemGrant;
  onChange: React.Dispatch<React.SetStateAction<FilesystemGrant>>;
  onCapabilityChange: (capability: ExtensionCapability, enabled: boolean) => void;
}) {
  const requestCount = FILESYSTEM_VERBS.reduce(
    (count, { key }) => count + filesystemRoots(requested, key).length,
    0,
  );
  if (requestCount === 0) return <Text label="No workspace paths requested." color="text-dim" />;

  return (
    <Column gap={1}>
      <Text
        label="File access is granted per action and path. A file means only that file; a folder subtree includes everything below it. Modify cannot create, delete, or rename."
        color="text-dim"
        wrap
      />
      <Text
        label={`${filesystemGrantCount(granted)}/${requestCount} workspace paths allowed`}
        color="text-dim"
      />
      {filesystemRoots(requested, 'delete').length + filesystemRoots(requested, 'rename').length >
      0 ? (
        <InlineMessage
          label="Destructive file access requested. Delete and rename can permanently change files within the selected paths."
          tone="warning"
        />
      ) : null}
      {FILESYSTEM_VERBS.map(({ key, label }) => {
        const selectors = filesystemRoots(requested, key);
        if (selectors.length === 0) return null;
        const selected = filesystemRoots(granted, key);
        return (
          <Column key={key} gap={1}>
            <Text label={`${label} · ${selected.length}/${selectors.length}`} color="text-dim" />
            {selectors.map((selector) => (
              <FormControlLabel
                key={`${key}:${filesystemSelectorKey(selector)}`}
                label={filesystemConsentLabel(selector, label)}
                gap={2}
              >
                <Switch
                  checked={selected.some(
                    (candidate) =>
                      filesystemSelectorKey(candidate) === filesystemSelectorKey(selector),
                  )}
                  onToggle={(event: Change) => {
                    const next = {
                      ...granted,
                      [key]: event.value
                        ? [...selected, selector]
                        : selected.filter(
                            (candidate) =>
                              filesystemSelectorKey(candidate) !== filesystemSelectorKey(selector),
                          ),
                    };
                    const capability = key === 'read' ? 'filesystem:read' : 'filesystem:write';
                    const enabled =
                      capability === 'filesystem:read'
                        ? filesystemRoots(next, 'read').length > 0
                        : (['write', 'create', 'delete', 'rename'] as const).some(
                            (verb) => filesystemRoots(next, verb).length > 0,
                          );
                    onCapabilityChange(capability, enabled);
                    onChange(next);
                  }}
                />
              </FormControlLabel>
            ))}
          </Column>
        );
      })}
    </Column>
  );
}

function InstalledPermissionSummary({ extension }: { extension: ExtensionSummary }) {
  const capabilities = extension.granted ?? [];
  const containerSelectors = extension.containers?.selectors ?? [];
  const containerCount = containerSelectors.length + Number(extension.containers?.create ?? false);
  const networkSelectors = extension.networks?.selectors ?? [];
  const networkCount = networkSelectors.length + Number(extension.networks?.create ?? false);
  const volumeSelectors = extension.volumes?.selectors ?? [];
  const volumeCount = volumeSelectors.length + Number(extension.volumes?.create ?? false);
  const filesystemCount = extension.filesystem ? filesystemGrantCount(extension.filesystem) : 0;
  const environmentRead = extension.workspace_environment?.read ?? [];
  const environmentWrite = extension.workspace_environment?.write ?? [];
  const environmentCount = environmentRead.length + environmentWrite.length;
  const total =
    capabilities.length +
    containerCount +
    networkCount +
    volumeCount +
    filesystemCount +
    environmentCount;
  const summary = [
    capabilities.length === 1
      ? capabilityLabel(capabilities[0])
      : capabilities.length
        ? countLabel(capabilities.length, 'API scope')
        : '',
    containerCount ? countLabel(containerCount, 'container rule') : '',
    networkCount ? countLabel(networkCount, 'network rule') : '',
    volumeCount ? countLabel(volumeCount, 'volume rule') : '',
    filesystemCount ? countLabel(filesystemCount, 'file rule') : '',
    environmentCount ? countLabel(environmentCount, 'environment rule') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Expander label={`Granted access · ${total ? summary : 'None'}`}>
      <Column gap={1}>
        <Text label="Effective for this installed image digest" color="text-dim" />
        {capabilities.map((capability) => (
          <Text key={capability} label={capabilityLabel(capability)} wrap />
        ))}
        {containerSelectors.map((selector, index) => (
          <Text
            key={`container:${index}`}
            label={
              'all' in selector
                ? 'Containers · all containers'
                : 'id' in selector
                  ? `Container · exact ID ${selector.id}`
                  : `Container · exact name ${selector.name}`
            }
            wrap
          />
        ))}
        {extension.containers?.create ? <Text label="Containers · create new containers" /> : null}
        {networkSelectors.map((selector, index) => (
          <Text
            key={`network:${index}`}
            label={`Network · ${networkSelectorLabel(selector)}`}
            wrap
          />
        ))}
        {extension.networks?.create ? <Text label="Networks · create new networks" /> : null}
        {volumeSelectors.map((selector, index) => (
          <Text key={`volume:${index}`} label={`Volume · ${volumeSelectorLabel(selector)}`} wrap />
        ))}
        {extension.volumes?.create ? <Text label="Volumes · create new volumes" /> : null}
        {extension.filesystem
          ? FILESYSTEM_VERBS.flatMap(({ key, label }) =>
              filesystemRoots(extension.filesystem!, key).map((selector) => (
                <Text
                  key={`${key}:${filesystemSelectorKey(selector)}`}
                  label={filesystemConsentLabel(selector, label)}
                  wrap
                />
              )),
            )
          : null}
        {(['read', 'write'] as const).flatMap((verb) =>
          (extension.workspace_environment?.[verb] ?? []).map((selector, index) => (
            <Text
              key={`${verb}:${index}`}
              label={
                'all' in selector
                  ? `Environment · ${verb} all names`
                  : `Environment · ${verb} ${selector.name} in workspace ${selector.workspace}`
              }
              wrap
            />
          )),
        )}
      </Column>
    </Expander>
  );
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function RequestedPermissionSummary({ groups }: { groups: { label: string; count: number }[] }) {
  const requested = groups.filter(({ count }) => count > 0);
  if (requested.length === 0) {
    return <Text label="No workspace access requested" color="text-dim" />;
  }
  return (
    <Column gap={0}>
      <Text label="Requested access" color="text-dim" />
      <Text
        label={requested.map(({ label, count }) => `${label} · ${count}`).join('  ·  ')}
        color="text-dim"
        wrap
      />
    </Column>
  );
}

function AcquisitionIdentity({
  acquisition,
  catalogueEntry,
  expanded,
  onExpandedChange,
}: {
  acquisition: ExtensionAcquisitionStatus & {
    candidate: NonNullable<ExtensionAcquisitionStatus['candidate']>;
  };
  catalogueEntry: ExtensionCatalogueEntry | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  return (
    <Column gap={1} width="fill">
      {catalogueEntry ? (
        <Row gap={1} width="fill" align="center" justify="start" wrap>
          <Text label={catalogueEntry.publisher} grow />
          <Badge
            {...catalogueTrust(catalogueEntry)}
            label={
              catalogueEntry.publisher_verified ? 'Verified publisher' : 'Unverified publisher'
            }
          />
        </Row>
      ) : (
        <Badge label="Direct OCI image" tone="warning" />
      )}
      <Expander
        label="Package identity"
        expanded={expanded}
        onExpand={(event: Change) => onExpandedChange(Boolean(event.value))}
      >
        <Column gap={1} pad={{ bottom: 1 }} width="fill">
          <Text
            label={`Package · ${compactImageReference(acquisition.reference)}`}
            color="text-dim"
            tooltip={acquisition.reference}
            wrap
          />
          <Text
            label={`Verified digest · ${compactDigest(acquisition.candidate.image_digest)}`}
            color="text-dim"
            tooltip={acquisition.candidate.image_digest}
            wrap
          />
          {catalogueEntry ? (
            <Text label={`Catalogue source · ${catalogueEntry.source}`} color="text-dim" wrap />
          ) : null}
        </Column>
      </Expander>
    </Column>
  );
}

export function Extensions({
  api,
  initialReference = '',
  onReferenceChange,
  onOpenWorkspaceSettings,
}: {
  api: WorkspaceApi;
  initialReference?: string;
  onReferenceChange?: (reference: string) => void;
  onOpenWorkspaceSettings?: () => void;
}) {
  const [mode, setMode] = React.useState<ExtensionMode>(
    initialReference ? 'discover' : 'installed',
  );
  const [installed, setInstalled] = React.useState<ExtensionSummary[]>([]);
  const [catalogue, setCatalogue] = React.useState<ExtensionCatalogue | null>(null);
  const [catalogueState, setCatalogueState] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [catalogueError, setCatalogueError] = React.useState('');
  const [workspaceArchitecture, setWorkspaceArchitecture] = React.useState('');
  const [workspaceIdentityState, setWorkspaceIdentityState] = React.useState<
    'loading' | 'ready' | 'error'
  >(typeof api.info === 'function' ? 'loading' : 'ready');
  const [workspaceIdentityError, setWorkspaceIdentityError] = React.useState('');
  const [inventoryState, setInventoryState] = React.useState<
    'loading' | 'empty' | 'error' | 'ready'
  >('loading');
  const [inventoryError, setInventoryError] = React.useState('');
  const [watchError, setWatchError] = React.useState('');
  const [reference, setReferenceState] = React.useState(initialReference);
  const setReference = (next: string) => {
    setReferenceState(next);
    onReferenceChange?.(next);
  };
  const [acquisition, setAcquisition] = React.useState<ExtensionAcquisitionStatus | null>(null);
  const [catalogueExpectation, setCatalogueExpectation] =
    React.useState<ExtensionCatalogueEntry | null>(null);
  const [granted, setGranted] = React.useState<ExtensionCapability[]>([]);
  const [grantedContainers, setGrantedContainers] = React.useState<ContainerGrant>({
    selectors: [],
    create: false,
  });
  const [grantedImages, setGrantedImages] = React.useState<ImageGrant>({
    read: [],
    use: [],
    pull: [],
    remove: [],
    prune_all_unused: false,
  });
  const [grantedNetworks, setGrantedNetworks] = React.useState<NetworkGrant>({
    selectors: [],
    create: false,
  });
  const [grantedVolumes, setGrantedVolumes] = React.useState<VolumeGrant>({
    selectors: [],
    create: false,
  });
  const [grantedFilesystem, setGrantedFilesystem] =
    React.useState<FilesystemGrant>(emptyFilesystemGrant);
  const [grantedWorkspaceEnvironment, setGrantedWorkspaceEnvironment] =
    React.useState<WorkspaceEnvironmentGrant>({ read: [], write: [] });
  const [grantedCredentials, setGrantedCredentials] = React.useState<CredentialGrant>({
    read: [],
    write: [],
    expose_to_execution: [],
  });
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [pendingLifecycle, setPendingLifecycle] = React.useState<LifecycleState | null>(null);
  const [lifecycleFailure, setLifecycleFailure] = React.useState<
    (LifecycleState & { detail: string }) | null
  >(null);
  const [notice, setNotice] = React.useState<{ label: string; uncertain: boolean } | null>(null);
  const [opening, setOpening] = React.useState('');
  const [providerFailure, setProviderFailure] = React.useState<ProviderFailure | null>(null);
  const [catalogueQuery, setCatalogueQuery] = React.useState('');
  const [catalogueFilter, setCatalogueFilter] = React.useState<CatalogueFilter>('discover');
  const [catalogueCategory, setCatalogueCategory] = React.useState('');
  const [catalogueLimit, setCatalogueLimit] = React.useState(CATALOGUE_PAGE_SIZE);
  const [installedQuery, setInstalledQuery] = React.useState('');
  const [installedFilter, setInstalledFilter] = React.useState<InstalledFilter>('all');
  const [installedLimit, setInstalledLimit] = React.useState(INSTALLED_PAGE_SIZE);
  const [removalMenu, setRemovalMenu] = React.useState('');
  const [permissionDetailsExpanded, setPermissionDetailsExpanded] = React.useState(false);
  const [identityDetailsExpanded, setIdentityDetailsExpanded] = React.useState(false);
  const cancelling = React.useRef(false);
  const cancelledJob = React.useRef('');
  const candidateKey = React.useRef('');
  const inventoryEpoch = React.useRef(0);
  const installedSnapshot = React.useRef<ExtensionSummary[]>([]);
  const catalogueEpoch = React.useRef(0);
  const workspaceIdentityEpoch = React.useRef(0);
  const acquisitionEpoch = React.useRef(0);
  const lifecycleInFlight = React.useRef(false);
  const acquisitionInFlight = React.useRef(false);
  const openingInFlight = React.useRef('');

  React.useEffect(() => {
    // Acquisition jobs and their reviewed grants belong to one workspace API.
    // A replacement connection must never inherit a candidate (or an async
    // completion) from the workspace it replaced.
    ++acquisitionEpoch.current;
    acquisitionInFlight.current = false;
    cancelling.current = false;
    cancelledJob.current = '';
    candidateKey.current = '';
    setAcquisition(null);
    setCatalogueExpectation(null);
    setGranted([]);
    setGrantedContainers({ selectors: [], create: false });
    setGrantedImages({ read: [], use: [], pull: [], remove: [], prune_all_unused: false });
    setGrantedNetworks({ selectors: [], create: false });
    setGrantedVolumes({ selectors: [], create: false });
    setGrantedFilesystem(emptyFilesystemGrant());
    setGrantedWorkspaceEnvironment({ read: [], write: [] });
    setGrantedCredentials({ read: [], write: [], expose_to_execution: [] });
    setBusy('');
    setError('');
  }, [api]);

  const selectMode = (next: ExtensionMode) => {
    if (next === mode) return;
    setMode(next);
    setCatalogueQuery('');
    setCatalogueFilter('discover');
    setCatalogueCategory('');
    setCatalogueLimit(CATALOGUE_PAGE_SIZE);
    setInstalledQuery('');
    setInstalledFilter('all');
    setInstalledLimit(INSTALLED_PAGE_SIZE);
  };

  const revealInstalled = (name: string) => {
    setMode('installed');
    setCatalogueQuery('');
    setCatalogueFilter('discover');
    setCatalogueCategory('');
    setCatalogueLimit(CATALOGUE_PAGE_SIZE);
    setInstalledQuery(name);
    setInstalledFilter('all');
    setInstalledLimit(INSTALLED_PAGE_SIZE);
  };

  const reload = React.useCallback(async () => {
    const epoch = ++inventoryEpoch.current;
    setInventoryState('loading');
    setInventoryError('');
    try {
      const listing = await api.extensions.list();
      if (inventoryEpoch.current !== epoch) return;
      installedSnapshot.current = listing;
      setInstalled(listing);
      setInventoryState(listing.length === 0 ? 'empty' : 'ready');
      return listing;
    } catch (cause) {
      if (inventoryEpoch.current !== epoch) return;
      installedSnapshot.current = [];
      setInstalled([]);
      setInventoryError(message(cause));
      setInventoryState('error');
      return null;
    }
  }, [api]);
  const watchExtensions = api.watchExtensions;
  React.useEffect(() => {
    void reload();
  }, [reload]);
  const loadCatalogue = React.useCallback(async () => {
    const readCatalogue = api.extensions.catalogue;
    if (!readCatalogue) return;
    const epoch = ++catalogueEpoch.current;
    setCatalogueState('loading');
    setCatalogueError('');
    setCatalogueExpectation(staleCatalogueExpectation);
    try {
      const value = await readCatalogue();
      if (catalogueEpoch.current !== epoch) return;
      setCatalogue(value);
      setCatalogueState('ready');
    } catch (cause) {
      if (catalogueEpoch.current !== epoch) return;
      setCatalogueError(message(cause));
      setCatalogueState('error');
    }
  }, [api]);
  React.useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);
  const loadWorkspaceIdentity = React.useCallback(async () => {
    if (typeof api.info !== 'function') return;
    const epoch = ++workspaceIdentityEpoch.current;
    setWorkspaceIdentityState('loading');
    setWorkspaceIdentityError('');
    try {
      const workspace = await api.info();
      if (workspaceIdentityEpoch.current !== epoch) return;
      setWorkspaceArchitecture(workspace.architecture);
      setWorkspaceIdentityState('ready');
    } catch (cause) {
      if (workspaceIdentityEpoch.current !== epoch) return;
      setWorkspaceArchitecture('');
      setWorkspaceIdentityError(message(cause));
      setWorkspaceIdentityState('error');
    }
  }, [api]);
  React.useEffect(() => {
    void loadWorkspaceIdentity();
  }, [loadWorkspaceIdentity]);
  React.useEffect(() => {
    let active = true;
    let dispose: (() => Promise<void>) | undefined;
    void watchExtensions((listing) => {
      if (!active) return;
      ++inventoryEpoch.current;
      installedSnapshot.current = listing;
      setInstalled(listing);
      setInventoryState(listing.length === 0 ? 'empty' : 'ready');
      setInventoryError('');
    })
      .then((stop) => {
        if (!active) {
          void stop();
          return;
        }
        dispose = stop;
        setWatchError('');
      })
      .catch((cause) => {
        if (active) {
          setWatchError(
            `Live extension updates are unavailable: ${message(cause)} Refresh to read the current inventory.`,
          );
        }
      });
    return () => {
      active = false;
      void dispose?.();
    };
  }, [watchExtensions]);

  const inspect = async (suggested?: string, expected: ExtensionCatalogueEntry | null = null) => {
    const wanted = (suggested ?? reference).trim();
    if (!wanted || busy || acquisitionInFlight.current) return;
    acquisitionInFlight.current = true;
    const epoch = ++acquisitionEpoch.current;
    setReference(wanted);
    setCatalogueExpectation(expected);
    setBusy('inspect');
    setError('');
    setNotice(null);
    setPermissionDetailsExpanded(false);
    setIdentityDetailsExpanded(false);
    setAcquisition(null);
    candidateKey.current = '';
    try {
      const started = await api.extensions.startAcquisition(wanted, {
        refresh: expected !== null,
      });
      if (acquisitionEpoch.current !== epoch) return;
      cancelledJob.current = '';
      let status = await api.extensions.acquisition(started.job);
      if (acquisitionEpoch.current !== epoch) return;
      while (true) {
        if (!isInstalledCandidateUnchanged(status.candidate)) setAcquisition(status);
        if (status.candidate && !isInstalledCandidateUnchanged(status.candidate)) {
          const key = `${status.job}:${status.candidate.image_digest}`;
          if (candidateKey.current !== key) {
            candidateKey.current = key;
            // Every authority is opt-in. Inspection must never grant access,
            // including during an update where a manifest may have widened.
            setGranted([]);
            setGrantedContainers({ selectors: [], create: false });
            setGrantedImages({ read: [], use: [], pull: [], remove: [], prune_all_unused: false });
            setGrantedNetworks({ selectors: [], create: false });
            setGrantedVolumes({ selectors: [], create: false });
            setGrantedFilesystem(emptyFilesystemGrant());
            setGrantedWorkspaceEnvironment({ read: [], write: [] });
            setGrantedCredentials({ read: [], write: [], expose_to_execution: [] });
            // The decision summary already names every missing required grant.
            // Keep the full matrix deliberate: opening a review should not turn
            // one required permission into a viewport-filling wall of optional
            // switches.
            setPermissionDetailsExpanded(false);
            setIdentityDetailsExpanded(false);
          }
        }
        if (
          status.state === 'ready' ||
          status.state === 'failed' ||
          status.state === 'cancelled' ||
          cancelledJob.current === started.job
        )
          break;
        const changed = await api.extensions.waitForAcquisition(started.job, status.revision, {
          // Each socket wait stays bounded, while the review remains attached
          // to the host-owned job for however long the registry operation needs.
          timeoutMs: 1_000,
        });
        if (acquisitionEpoch.current !== epoch) return;
        if (changed.changed) status = changed.status;
      }
      if (isInstalledCandidateUnchanged(status.candidate)) {
        setAcquisition(null);
        setNotice({
          label: `${status.candidate?.name ?? wanted} is up to date. The reviewed image already matches the installed image; access was not changed.`,
          uncertain: false,
        });
      }
    } catch (cause) {
      if (acquisitionEpoch.current === epoch) setError(acquisitionConnectionFailure(cause));
    } finally {
      if (acquisitionEpoch.current === epoch) {
        acquisitionInFlight.current = false;
        setBusy('');
      }
    }
  };
  const publish = async () => {
    if (
      !acquisition?.candidate ||
      acquisition.state !== 'ready' ||
      isInstalledCandidateUnchanged(acquisition.candidate) ||
      catalogueCandidateMismatch(
        catalogueExpectation,
        acquisition.candidate,
        acquisition.reference,
      ) ||
      busy
    )
      return;
    const updating = Boolean(acquisition.candidate.installed_image_digest);
    const reviewed = acquisition.candidate;
    setBusy(updating ? 'update' : 'install');
    setError('');
    setNotice(null);
    try {
      const result = await api.extensions[updating ? 'updateAndWait' : 'installAndWait'](
        acquisition.job,
        acquisition.revision,
        {
          capabilities: granted,
          containers: grantedContainers,
          images: grantedImages,
          networks: grantedNetworks,
          volumes: grantedVolumes,
          filesystem: grantedFilesystem,
          workspaceEnvironment: grantedWorkspaceEnvironment,
          credentials: grantedCredentials,
        },
      );
      setAcquisition(null);
      setReference('');
      const listing = await reload();
      const confirmed =
        result.changed &&
        listing?.some(
          (extension) =>
            extension.name === result.extension.name &&
            extension.image_digest === result.extension.image_digest,
        );
      if (result.changed && confirmed) revealInstalled(result.extension.name);
      setNotice(
        result.changed && confirmed
          ? {
              label: `${result.extension.name} ${
                updating ? 'updated' : 'installed'
              } and confirmed in installed extensions.`,
              uncertain: false,
            }
          : {
              label: result.changed
                ? `${result.extension.name} ${updating ? 'updated' : 'installed'}, but installed extensions could not be verified. Refresh before acting again.`
                : `${updating ? 'Update' : 'Install'} was accepted, but the resulting extension was not observed. Refresh before acting again.`,
              uncertain: true,
            },
      );
    } catch (cause) {
      try {
        let status = await api.extensions.acquisition(acquisition.job);
        if (status.state === 'committing') {
          setAcquisition(status);
          setError('');
          // A vanished reply does not mean the commit stopped. Follow the
          // authoritative job instead of leaving a stale, replayable consent
          // form on screen while the host may be publishing it.
          const deadline = Date.now() + 30_000;
          while (status.state === 'committing') {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const changed = await api.extensions.waitForAcquisition(status.job, status.revision, {
              timeoutMs: Math.min(1_000, remaining),
            });
            if (!changed.changed) continue;
            status = changed.status;
            setAcquisition(status);
          }
        }
        if (status.state === 'failed' || status.state === 'cancelled') {
          setAcquisition(status);
          setError('');
        } else if (status.state === 'installed' || status.state === 'updated') {
          // The commit status is authoritative even when refreshing the
          // installed inventory fails. Preserve it so the review cannot be
          // replayed and the developer has an explicit reconciliation path.
          setAcquisition(status);
          let listing: Awaited<ReturnType<typeof api.extensions.list>>;
          try {
            listing = await api.extensions.list();
          } catch (verificationCause) {
            setError(
              `${reviewed.name} reports ${status.state}, but installed extensions could not be verified. ${message(verificationCause)}`,
            );
            return;
          }
          const committed = listing.find(
            (extension) =>
              extension.name === reviewed.name && extension.image_digest === reviewed.image_digest,
          );
          if (committed) {
            ++inventoryEpoch.current;
            installedSnapshot.current = listing;
            setInstalled(listing);
            setInventoryState(listing.length === 0 ? 'empty' : 'ready');
            setInventoryError('');
            setAcquisition(null);
            setReference('');
            revealInstalled(committed.name);
            setNotice({
              label: `${reviewed.name} ${updating ? 'updated' : 'installed'}, but the confirmation reply was lost. Current extension state was verified by refresh.`,
              uncertain: false,
            });
          } else {
            setError(message(cause));
          }
        } else if (status.state === 'committing') {
          setError(
            'The install is still being saved after its confirmation reply was lost. Wait for completion before acting again.',
          );
        } else if (status.state === 'ready' && status.candidate) {
          if (extensionCommitConflict(cause)) {
            try {
              const reconciliationEpoch = ++inventoryEpoch.current;
              const listing = await api.extensions.list();
              const authoritative =
                inventoryEpoch.current === reconciliationEpoch
                  ? listing
                  : installedSnapshot.current;
              if (inventoryEpoch.current === reconciliationEpoch) {
                installedSnapshot.current = listing;
                setInstalled(listing);
                setInventoryState(listing.length === 0 ? 'empty' : 'ready');
                setInventoryError('');
              }
              setAcquisition(null);
              candidateKey.current = '';
              const current = authoritative.find((extension) => extension.name === reviewed.name);
              if (current) revealInstalled(current.name);
              setNotice({
                label: `${reviewed.name} changed while this review was open. Current installed state was refreshed. Inspect the image again before changing access.`,
                uncertain: false,
              });
            } catch (refreshCause) {
              setAcquisition(status);
              setError(
                `${reviewed.name} changed while this review was open, but current installed state could not be refreshed. Keep this review open, refresh extensions, then inspect the image again. ${message(refreshCause)}`,
              );
            }
          } else {
            setAcquisition(status);
            setError(
              `The extension was not saved. Its reviewed image and selected access are retained for a safe retry. ${message(cause)}`,
            );
          }
        } else {
          setAcquisition(status);
          setError(message(cause));
        }
      } catch (statusCause) {
        // Acquisition jobs belong to the workspace service process, while an
        // installed extension is durable. A restart can therefore erase the
        // job immediately after the commit crossed the socket. Reconcile the
        // immutable candidate digest before presenting a failure or leaving a
        // stale consent form that can no longer be committed safely.
        const acquisitionWasLost =
          (statusCause &&
            typeof statusCause === 'object' &&
            (statusCause as { kind?: unknown }).kind === 'absent') ||
          /extension acquisition .*(absent|not found|does not exist)/i.test(message(statusCause));
        const interruption = acquisitionWasLost
          ? 'the workspace service restarted'
          : 'acquisition status became unavailable';
        try {
          const reconciliationEpoch = ++inventoryEpoch.current;
          const listing = await api.extensions.list();
          if (inventoryEpoch.current === reconciliationEpoch) {
            installedSnapshot.current = listing;
            setInstalled(listing);
            setInventoryState(listing.length === 0 ? 'empty' : 'ready');
            setInventoryError('');
          }
          const committed = listing.find(
            (extension) =>
              extension.name === reviewed.name && extension.image_digest === reviewed.image_digest,
          );
          if (committed) {
            setAcquisition(null);
            setCatalogueExpectation(null);
            candidateKey.current = '';
            setReference('');
            revealInstalled(committed.name);
            setError('');
            setNotice({
              label: `${reviewed.name} ${updating ? 'updated' : 'installed'}, but ${interruption} before confirmation. Current extension state was verified by refresh.`,
              uncertain: false,
            });
          } else {
            setError(
              `${reviewed.name} could not be confirmed after ${interruption}. Refresh extensions, then inspect the image again before changing access.`,
            );
          }
        } catch (verificationCause) {
          setError(
            `${message(cause)} Current installed state could not be verified after ${interruption}: ${message(verificationCause)}`,
          );
        }
      }
    } finally {
      setBusy('');
    }
  };
  const dismissReview = () => {
    setAcquisition(null);
    setCatalogueExpectation(null);
    setPermissionDetailsExpanded(false);
    setIdentityDetailsExpanded(false);
    setGranted([]);
    setGrantedContainers({ selectors: [], create: false });
    setGrantedImages({ read: [], use: [], pull: [], remove: [], prune_all_unused: false });
    setGrantedNetworks({ selectors: [], create: false });
    setGrantedVolumes({ selectors: [], create: false });
    setGrantedFilesystem(emptyFilesystemGrant());
    setGrantedWorkspaceEnvironment({ read: [], write: [] });
    setGrantedCredentials({ read: [], write: [], expose_to_execution: [] });
    candidateKey.current = '';
    setError('');
  };
  const backToCatalogue = () => {
    dismissReview();
    setReference('');
    setMode('discover');
  };
  const verifyCommittedAcquisition = () => {
    const name = acquisition?.candidate?.name;
    if (!name || busy) return;
    dismissReview();
    revealInstalled(name);
    void reload();
  };
  const cancel = async () => {
    if (
      !acquisition ||
      ['ready', 'committing', 'installed', 'updated', 'failed', 'cancelled'].includes(
        acquisition.state,
      ) ||
      cancelling.current
    )
      return;
    cancelling.current = true;
    cancelledJob.current = acquisition.job;
    setBusy('cancel');
    let accepted = false;
    try {
      await api.extensions.cancelAcquisition(acquisition.job, acquisition.revision);
      accepted = true;
      setAcquisition(await api.extensions.acquisition(acquisition.job));
    } catch (cause) {
      if (accepted) {
        setAcquisition({ ...acquisition, state: 'cancelled', progress: null, error: null });
        setError(acquisitionCancellationUnverified(message(cause)));
        return;
      }
      cancelledJob.current = '';
      try {
        const current = await api.extensions.acquisition(acquisition.job);
        setAcquisition(current);
        setError(acquisitionCancellationRecovery(current.state));
      } catch {
        setError(
          `Cancellation failed: ${message(cause)} Retry inspection to reconcile its current state.`,
        );
      }
    } finally {
      cancelling.current = false;
      setBusy('');
    }
  };
  const lifecycle = async (extension: ExtensionSummary, action: LifecycleAction) => {
    if (lifecycleInFlight.current) return;
    lifecycleInFlight.current = true;
    const operation = { action, name: extension.name };
    setBusy(`${action}:${extension.name}`);
    setPendingLifecycle(operation);
    setLifecycleFailure(null);
    setError('');
    setNotice(null);
    try {
      const result = await api.extensions[`${action}AndWait`](
        extension.name,
        extension.image_digest,
      );
      await reload();
      setNotice(
        result.changed
          ? {
              label: `${extension.name} ${lifecycleResult(action)} and verified.`,
              uncertain: false,
            }
          : {
              label: `${capitalize(action)} was accepted, but the resulting extension state was not observed. Refresh before acting again.`,
              uncertain: true,
            },
      );
    } catch (cause) {
      try {
        const reconciliationEpoch = ++inventoryEpoch.current;
        const listing = await api.extensions.list();
        const authoritative =
          inventoryEpoch.current === reconciliationEpoch ? listing : installedSnapshot.current;
        if (inventoryEpoch.current === reconciliationEpoch) {
          installedSnapshot.current = listing;
          setInstalled(listing);
          setInventoryState(listing.length === 0 ? 'empty' : 'ready');
          setInventoryError('');
        }
        const current = authoritative.find((item) => item.name === extension.name);
        if (lifecycleStateObserved(action, extension, current)) {
          setLifecycleFailure(null);
          setNotice({
            label: `${extension.name} ${lifecycleResult(action)}, but the confirmation reply was lost. Current extension state was verified by refresh.`,
            uncertain: false,
          });
          return;
        }
      } catch (reconciliationCause) {
        setLifecycleFailure({
          ...operation,
          detail: lifecycleReconciliationFailure(message(cause), message(reconciliationCause)),
        });
        return;
      }
      setLifecycleFailure({ ...operation, detail: message(cause) });
    } finally {
      lifecycleInFlight.current = false;
      setPendingLifecycle(null);
      setBusy('');
    }
  };
  const openProvider = async (extension: ExtensionSummary, provider: ExtensionPaneProvider) => {
    const operation = `open:${extension.name}:${provider.id}`;
    if (busy || openingInFlight.current === operation) return;
    openingInFlight.current = operation;
    setOpening(operation);
    setProviderFailure((failure) => (failure?.key === operation ? null : failure));
    setError('');
    setNotice(null);
    let openedTab = '';
    let mounted = false;
    try {
      const opened = await api.terminal.openTabAndWait(provider.title);
      openedTab = opened.tab;
      if (!opened.changed) {
        throw new Error('the new tab did not publish an observable pane');
      }
      const switched = await api.terminal.switchOccupantAndWait(
        opened.pane.slot,
        opened.pane.generation,
        opened.pane.revision,
        { kind: 'surface', extension: extension.name, provider: provider.id },
      );
      if (!switched.changed) {
        throw new Error('the extension surface did not become the pane occupant');
      }
      mounted = true;
      await api.terminal.focus(switched.pane.slot);
      setNotice({
        label: `${provider.title} opened in a new tab.`,
        uncertain: false,
      });
    } catch (cause) {
      setProviderFailure({
        key: operation,
        retry: Boolean(openedTab),
        detail: mounted
          ? `${provider.title} opened in tab ${openedTab}, but it could not be focused: ${message(cause)}`
          : openedTab
            ? `Tab ${openedTab} was created, but ${provider.title} did not open: ${message(cause)}`
            : `${provider.title} could not be opened: ${message(cause)}`,
      });
    } finally {
      if (openingInFlight.current === operation) openingInFlight.current = '';
      setOpening((current) => (current === operation ? '' : current));
    }
  };
  const providerAction = (extension: ExtensionSummary, provider: ExtensionPaneProvider) => {
    const key = `open:${extension.name}:${provider.id}`;
    const active = opening === key;
    const failure = providerFailure?.key === key ? providerFailure : null;
    return (
      <Column gap={1}>
        <Row gap={1} align="center" wrap>
          {active ? <Spinner /> : null}
          <Button
            label={active ? 'Opening…' : failure?.retry ? 'Retry opening' : 'Open'}
            tooltip={`Open ${provider.title}`}
            size="small"
            variant="filled"
            tone="accent"
            enabled={!busy && !active}
            onInvoke={() => openProvider(extension, provider)}
          />
        </Row>
        {failure ? <InlineMessage label={failure.detail} tone="danger" /> : null}
      </Column>
    );
  };
  const requestedContainers = acquisition?.candidate?.requested_containers ?? {
    selectors: [],
    create: false,
  };
  const requestedImages = acquisition?.candidate?.requested_images ?? {
    read: [],
    use: [],
    pull: [],
    remove: [],
    prune_all_unused: false,
  };
  const requestedNetworks = acquisition?.candidate?.requested_networks ?? {
    selectors: [],
    create: false,
  };
  const requestedVolumes = acquisition?.candidate?.requested_volumes ?? {
    selectors: [],
    create: false,
  };
  const requestedFilesystem = acquisition?.candidate?.requested_filesystem ?? {
    ...emptyFilesystemGrant(),
  };
  const catalogueEntries = React.useMemo(() => catalogue?.entries ?? [], [catalogue]);
  const catalogueAuthoritative = catalogueState === 'ready';
  const catalogueCategories = React.useMemo(
    () => [...new Set(catalogueEntries.flatMap((entry) => entry.categories ?? []))].sort(),
    [catalogueEntries],
  );
  const visibleCatalogueEntries = React.useMemo(
    () =>
      filterCatalogueEntries(
        catalogueEntries,
        installed,
        workspaceArchitecture,
        catalogueQuery,
        catalogueFilter,
        catalogueCategory,
      ),
    [
      catalogueCategory,
      catalogueEntries,
      catalogueFilter,
      catalogueQuery,
      installed,
      workspaceArchitecture,
    ],
  );
  const renderedCatalogueEntries = visibleCatalogueEntries.slice(0, catalogueLimit);
  const visibleInstalled = React.useMemo(
    () => filterInstalledExtensions(installed, catalogueEntries, installedQuery, installedFilter),
    [catalogueEntries, installed, installedFilter, installedQuery],
  );
  const renderedInstalled = visibleInstalled.slice(0, installedLimit);
  const requestedWorkspaceEnvironment = acquisition?.candidate?.requested_workspace_environment ?? {
    read: [],
    write: [],
  };
  const requestedCredentials = acquisition?.candidate?.requested_credentials ?? {
    read: [],
    write: [],
    expose_to_execution: [],
  };
  const requiredCapabilities = acquisition?.candidate?.required ?? [];
  const missingRequiredCapabilities = requiredCapabilities.filter(
    (capability) => !granted.includes(capability),
  );
  const catalogueMismatch = catalogueCandidateMismatch(
    catalogueExpectation,
    acquisition?.candidate,
    acquisition?.reference,
  );
  const requestedPermissionCount = acquisition?.candidate
    ? acquisition.candidate.requested.length +
      requestedContainers.selectors.length +
      Number(requestedContainers.create) +
      imageGrantCount(requestedImages) +
      requestedNetworks.selectors.length +
      Number(requestedNetworks.create) +
      requestedVolumes.selectors.length +
      Number(requestedVolumes.create) +
      filesystemGrantCount(requestedFilesystem) +
      requestedWorkspaceEnvironment.read.length +
      requestedWorkspaceEnvironment.write.length +
      requestedCredentials.read.length +
      requestedCredentials.write.length +
      requestedCredentials.expose_to_execution.length
    : 0;
  const grantedCredentialCount =
    grantedCredentials.read.length +
    grantedCredentials.write.length +
    grantedCredentials.expose_to_execution.length;
  const grantedPermissionCount =
    granted.length +
    grantedContainers.selectors.length +
    Number(grantedContainers.create) +
    imageGrantCount(grantedImages) +
    grantedNetworks.selectors.length +
    Number(grantedNetworks.create) +
    grantedVolumes.selectors.length +
    Number(grantedVolumes.create) +
    filesystemGrantCount(grantedFilesystem) +
    grantedWorkspaceEnvironment.read.length +
    grantedWorkspaceEnvironment.write.length +
    grantedCredentialCount;
  const requestedPermissionGroups = acquisition?.candidate
    ? [
        { label: 'Product', count: acquisition.candidate.requested.length },
        {
          label: 'Containers',
          count: requestedContainers.selectors.length + Number(requestedContainers.create),
        },
        { label: 'Images', count: imageGrantCount(requestedImages) },
        {
          label: 'Networks',
          count: requestedNetworks.selectors.length + Number(requestedNetworks.create),
        },
        {
          label: 'Volumes',
          count: requestedVolumes.selectors.length + Number(requestedVolumes.create),
        },
        { label: 'Files', count: filesystemGrantCount(requestedFilesystem) },
        {
          label: 'Environment',
          count:
            requestedWorkspaceEnvironment.read.length + requestedWorkspaceEnvironment.write.length,
        },
        {
          label: 'Credentials',
          count:
            requestedCredentials.read.length +
            requestedCredentials.write.length +
            requestedCredentials.expose_to_execution.length,
        },
      ]
    : [];
  const identityReviewWarning = acquisition?.candidate
    ? [
        catalogueExpectation
          ? !catalogueExpectation.publisher_verified
            ? 'Publisher is not verified; confirm the catalogue source and reviewed digest.'
            : null
          : 'Direct OCI image has no catalogue publisher verification; confirm its source and digest.',
        acquisition.candidate.installed_image_digest
          ? `Image changes from ${compactDigest(acquisition.candidate.installed_image_digest)}; access has been reset.`
          : null,
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const privilegedAccessWarning = [
    requestedImages.remove.length > 0 || requestedImages.prune_all_unused
      ? 'Image removal can delete named images or every unused workspace image.'
      : null,
    acquisition?.candidate?.requested.some((capability) =>
      ['workspaces:create', 'workspaces:lifecycle', 'workspaces:remove'].includes(capability),
    )
      ? 'Workspace lifecycle access can create or delete workspaces and start or stop workloads.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <Scroll
      key={acquisition?.candidate ? 'review' : mode}
      grow
      width="fill"
      height="fill"
      wholeRows={
        acquisition?.candidate
          ? missingRequiredCapabilities.length > 0
            ? 'permission-required'
            : 'permission-review'
          : undefined
      }
    >
      <Container
        pad={acquisition?.candidate ? { top: 4, end: 4, bottom: 18, start: 4 } : 4}
        gap={3}
        width={PAGE_WIDTH}
      >
        <Heading label="Extensions" scale="display" />
        {!acquisition ? (
          <>
            <Text
              label="Discover tools, review their access, and manage what runs in this workspace."
              color="text-dim"
              wrap
            />
            <ToggleButtonGroup gap={0} width="content">
              <ToggleButton
                label="Installed"
                selected={mode === 'installed'}
                size="small"
                onToggle={() => selectMode('installed')}
              />
              <ToggleButton
                label="Discover"
                selected={mode === 'discover'}
                size="small"
                onToggle={() => selectMode('discover')}
              />
            </ToggleButtonGroup>
          </>
        ) : (
          <>
            <Text label="Extension catalogue · Discover" color="text-dim" />
            {acquisition.candidate ? (
              <CardHeader
                label={`Review ${acquisition.candidate.name}`}
                detail={`${acquisition.candidate.installed_image_digest ? 'Update' : 'Install'} extension · version ${acquisition.candidate.version}`}
                align="start"
                width="fill"
              />
            ) : null}
          </>
        )}
        {error && <RecoveryState operation="Extension change" error={error} />}
        {notice && (
          <InlineMessage label={notice.label} tone={notice.uncertain ? 'warning' : 'positive'} />
        )}
        <Column gap={3} width="fill">
          {mode === 'discover' || acquisition ? (
            <Column gap={2} width="fill">
              {!acquisition && (
                <Row gap={1} width="fill" align="center" justify="start" wrap>
                  <Heading label="Find extensions" scale="caption" grow={false} align="start" />
                  {catalogueState === 'ready' && catalogueEntries.length > 0 ? (
                    <Badge
                      label={`${countLabel(catalogueEntries.length, 'extension')}${
                        catalogueEntries.every((entry) =>
                          installed.some((extension) => extension.name === entry.id),
                        )
                          ? ' · all installed'
                          : ''
                      }`}
                    />
                  ) : null}
                </Row>
              )}
              {!acquisition && (
                <Column gap={1}>
                  {catalogueState === 'ready' && catalogueEntries.length > 0 ? (
                    <Responsive alternate breakpoint={760} width="fill">
                      <Column gap={2} width="fill">
                        <Search
                          value={catalogueQuery}
                          placeholder="Search extensions"
                          tooltip="Search by name, identifier, publisher, or description"
                          width="fill"
                          onChange={(event: Change) => {
                            setCatalogueQuery(String(event.value ?? '').slice(0, 128));
                            setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                          }}
                        />
                        <Row gap={2} width="fill" align="center" justify="start">
                          <Select
                            value={catalogueFilter}
                            tooltip="Filter extension catalogue by status"
                            grow
                            choices={[
                              { value: 'discover', label: 'Available & updates' },
                              { value: 'all', label: 'All extensions' },
                              { value: 'available', label: 'Available' },
                              { value: 'installed', label: 'Installed' },
                              { value: 'updates', label: 'Updates' },
                              { value: 'incompatible', label: 'Incompatible' },
                            ]}
                            onChange={(event: Change) => {
                              const selected = String(event.value ?? '');
                              if (
                                [
                                  'discover',
                                  'all',
                                  'available',
                                  'installed',
                                  'updates',
                                  'incompatible',
                                ].includes(selected)
                              ) {
                                setCatalogueFilter(selected as CatalogueFilter);
                                setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                              }
                            }}
                          />
                          <Text
                            label={`${visibleCatalogueEntries.length} of ${countLabel(catalogueEntries.length, 'extension')}`}
                            color="text-dim"
                          />
                        </Row>
                        <FormControl gap={1} width="fill">
                          <Text label="Category" color="text-dim" />
                          <Select
                            value={catalogueCategory}
                            tooltip="Filter extension catalogue by category"
                            width="fill"
                            choices={[
                              { value: '', label: 'All categories' },
                              ...catalogueCategories.map((category) => ({
                                value: category,
                                label: category,
                              })),
                            ]}
                            onChange={(event: Change) => {
                              setCatalogueCategory(String(event.value ?? ''));
                              setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                            }}
                          />
                        </FormControl>
                      </Column>
                      <Column gap={0} width="fill">
                        <Row gap={2} width="fill" align="center" justify="start">
                          <Search
                            value={catalogueQuery}
                            placeholder="Search extensions"
                            tooltip="Search by name, identifier, publisher, or description"
                            width={{ minimum: { chars: 24 }, maximum: { chars: 34 } }}
                            onChange={(event: Change) => {
                              setCatalogueQuery(String(event.value ?? '').slice(0, 128));
                              setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                            }}
                          />
                          <Select
                            value={catalogueFilter}
                            tooltip="Filter extension catalogue by status"
                            width={{ minimum: { chars: 16 }, maximum: { chars: 22 } }}
                            choices={[
                              { value: 'discover', label: 'Available & updates' },
                              { value: 'all', label: 'All extensions' },
                              { value: 'available', label: 'Available' },
                              { value: 'installed', label: 'Installed' },
                              { value: 'updates', label: 'Updates' },
                              { value: 'incompatible', label: 'Incompatible' },
                            ]}
                            onChange={(event: Change) => {
                              const selected = String(event.value ?? '');
                              if (
                                [
                                  'discover',
                                  'all',
                                  'available',
                                  'installed',
                                  'updates',
                                  'incompatible',
                                ].includes(selected)
                              ) {
                                setCatalogueFilter(selected as CatalogueFilter);
                                setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                              }
                            }}
                          />
                          <Text
                            label={`${visibleCatalogueEntries.length} of ${countLabel(catalogueEntries.length, 'extension')}`}
                            color="text-dim"
                          />
                          <FormControl gap={0} grow width={{ minimum: { chars: 14 } }}>
                            <Text label="Category" color="text-dim" />
                            <Select
                              grow
                              value={catalogueCategory}
                              tooltip="Filter extension catalogue by category"
                              width="fill"
                              choices={[
                                { value: '', label: 'All categories' },
                                ...catalogueCategories.map((category) => ({
                                  value: category,
                                  label: category,
                                })),
                              ]}
                              onChange={(event: Change) => {
                                setCatalogueCategory(String(event.value ?? ''));
                                setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                              }}
                            />
                          </FormControl>
                        </Row>
                      </Column>
                    </Responsive>
                  ) : null}
                  {catalogueState === 'loading' && (
                    <Row gap={1} align="center">
                      <Spinner />
                      <Text label="Loading extension catalogue…" color="text-dim" />
                    </Row>
                  )}
                  {workspaceIdentityState === 'error' && (
                    <RecoveryState
                      operation="Workspace compatibility check"
                      summary="Compatibility could not be checked, so catalogue installs are paused."
                      error={workspaceIdentityError}
                      retryLabel="Retry compatibility check"
                      onRetry={loadWorkspaceIdentity}
                    />
                  )}
                  {catalogueState === 'ready' && catalogueEntries.length === 0 && (
                    <InlineMessage
                      label="The built-in extension catalogue is currently empty."
                      width={COPY_WIDTH}
                      tone="neutral"
                    />
                  )}
                  {catalogueEntries.length > 0 && visibleCatalogueEntries.length === 0 ? (
                    <Column gap={1} align="start">
                      <InlineMessage
                        label="No extensions match this search and status filter."
                        tone="neutral"
                      />
                      <Button
                        label="Clear filters"
                        size="small"
                        onInvoke={() => {
                          setCatalogueQuery('');
                          setCatalogueFilter('discover');
                          setCatalogueCategory('');
                          setCatalogueLimit(CATALOGUE_PAGE_SIZE);
                        }}
                      />
                    </Column>
                  ) : null}
                  {visibleCatalogueEntries.length > 0 && (
                    <Row gap={1} width="fill" wrap>
                      {renderedCatalogueEntries.map((entry) => {
                        const compatibility = catalogueCompatibility(entry, workspaceArchitecture);
                        const trust = catalogueTrust(
                          catalogueAuthoritative ? entry : { ...entry, publisher_verified: false },
                        );
                        const installedExtension = installed.find(
                          (extension) => extension.name === entry.id,
                        );
                        const builtIn = installedExtension?.name === 'top';
                        const updateAvailable = Boolean(
                          installedExtension &&
                          !builtIn &&
                          catalogueUpdateAvailable(entry, installedExtension),
                        );
                        const provider = installedExtension?.pane_providers?.[0];
                        return (
                          <Card
                            key={entry.id}
                            grow={false}
                            height="content"
                            width={{ minimum: { chars: 38 }, maximum: 'fill' }}
                            variant="outline"
                          >
                            <CardContent gap={1} grow={false}>
                              <Row gap={1} width="fill" align="center" justify="start">
                                <Text label={entry.title} grow />
                                <Text label={`v${entry.version}`} color="text-dim" />
                              </Row>
                              <Text
                                label={entry.description}
                                color="text-dim"
                                tooltip={entry.description}
                                wrap
                              />
                              <Row gap={2} width="fill" wrap align="center" justify="start">
                                <Badge
                                  label={
                                    installedExtension
                                      ? builtIn
                                        ? 'Installed · built-in'
                                        : updateAvailable
                                          ? 'Update available'
                                          : 'Installed · current'
                                      : 'Available'
                                  }
                                  tone={
                                    updateAvailable
                                      ? 'accent'
                                      : installedExtension
                                        ? 'positive'
                                        : 'neutral'
                                  }
                                />
                                <Badge
                                  {...trust}
                                  label={`${entry.publisher} · ${trust.label === 'Verified publisher' ? 'Verified' : 'Unverified'}`}
                                />
                                {!catalogueAuthoritative ? (
                                  <Badge label="Cached · refresh required" tone="warning" />
                                ) : null}
                                <Text
                                  label={`Category · ${entry.categories?.[0] ?? 'Other'}`}
                                  color="text-dim"
                                />
                                {compatibility.compatible !== true ? (
                                  <Badge
                                    label={
                                      compatibility.compatible === false
                                        ? 'Incompatible'
                                        : 'Compatibility undeclared'
                                    }
                                    tone={compatibility.compatible === false ? 'danger' : 'warning'}
                                  />
                                ) : null}
                              </Row>
                              {compatibility.compatible !== true ? (
                                <Text
                                  label={compatibility.label}
                                  color={
                                    compatibility.compatible === false ? 'warning' : 'text-dim'
                                  }
                                  wrap
                                />
                              ) : null}
                              <Expander label="Trust details" expanded={false}>
                                <Column gap={1}>
                                  <Text
                                    label={`Publisher · ${entry.publisher}`}
                                    color="text-dim"
                                    wrap
                                  />
                                  <Text
                                    label={`Catalogue source · ${entry.source}`}
                                    color="text-dim"
                                    wrap
                                  />
                                  <Text
                                    label={`Categories · ${(entry.categories ?? []).join(', ')}`}
                                    color="text-dim"
                                    wrap
                                  />
                                  <Text
                                    label={`Image · ${compactImageReference(entry.reference)}`}
                                    color="text-dim"
                                    tooltip={entry.reference}
                                    wrap
                                  />
                                  <Text
                                    label={`Protocol ${entry.protocol ?? 'unavailable'} · ${entry.architectures?.join(', ') || 'architecture unavailable'}`}
                                    color="text-dim"
                                    wrap
                                  />
                                  {installedExtension ? (
                                    <Text
                                      label={`Installed image · ${capitalize(extensionState(installedExtension))} · ${compactDigest(installedExtension.image_digest)}`}
                                      color="text-dim"
                                      tooltip={installedExtension.image_digest}
                                      wrap
                                    />
                                  ) : null}
                                </Column>
                              </Expander>
                              <Row gap={3} width="fill" wrap align="center" justify="start">
                                {builtIn ? (
                                  installedExtension && provider ? (
                                    providerAction(installedExtension, provider)
                                  ) : null
                                ) : updateAvailable ? (
                                  <>
                                    <Button
                                      label="Review update"
                                      tooltip={`Review the ${entry.version} update for ${entry.title}`}
                                      size="small"
                                      variant="filled"
                                      tone="accent"
                                      enabled={
                                        catalogueAuthoritative &&
                                        workspaceIdentityState === 'ready' &&
                                        !busy &&
                                        compatibility.compatible !== false
                                      }
                                      onInvoke={() => inspect(entry.reference, entry)}
                                    />
                                    {installedExtension && installedExtension.enabled && provider
                                      ? providerAction(installedExtension, provider)
                                      : null}
                                  </>
                                ) : !installedExtension ? (
                                  <Button
                                    label="Review install"
                                    tooltip={`Review installation access for ${entry.title}`}
                                    size="small"
                                    variant="outline"
                                    tone="neutral"
                                    enabled={
                                      catalogueAuthoritative &&
                                      workspaceIdentityState === 'ready' &&
                                      !busy &&
                                      compatibility.compatible !== false
                                    }
                                    onInvoke={() => inspect(entry.reference, entry)}
                                  />
                                ) : (
                                  <>
                                    {provider ? providerAction(installedExtension, provider) : null}
                                    <Button
                                      label="Check current image"
                                      tooltip={`Inspect ${entry.reference} again and compare its immutable digest`}
                                      size="small"
                                      variant="outline"
                                      enabled={
                                        catalogueAuthoritative &&
                                        workspaceIdentityState === 'ready' &&
                                        !busy &&
                                        compatibility.compatible !== false
                                      }
                                      onInvoke={() => inspect(entry.reference, entry)}
                                    />
                                  </>
                                )}
                              </Row>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </Row>
                  )}
                  {visibleCatalogueEntries.length > renderedCatalogueEntries.length ? (
                    <Row gap={1} width="fill" wrap align="center" justify="start">
                      <Text
                        label={`Showing ${renderedCatalogueEntries.length} of ${visibleCatalogueEntries.length} matching extensions`}
                        color="text-dim"
                      />
                      <Button
                        label={`Show ${Math.min(CATALOGUE_PAGE_SIZE, visibleCatalogueEntries.length - renderedCatalogueEntries.length)} more`}
                        size="small"
                        onInvoke={() =>
                          setCatalogueLimit((current) => current + CATALOGUE_PAGE_SIZE)
                        }
                      />
                    </Row>
                  ) : null}
                  {catalogue && !catalogue.complete && (
                    <InlineMessage label="The built-in catalogue is incomplete." tone="warning" />
                  )}
                  {catalogueState === 'error' && (
                    <Column gap={1}>
                      <RecoveryState
                        operation="Extension catalogue"
                        error={catalogueError}
                        retryLabel="Retry catalogue"
                        onRetry={loadCatalogue}
                      />
                    </Column>
                  )}
                </Column>
              )}
              {!acquisition ? (
                <Expander label="Install from an OCI image" expanded={Boolean(reference)}>
                  <Card grow={false} width="fill" variant="outline">
                    <CardContent>
                      <Row gap={1} width="fill" wrap>
                        <Entry
                          grow={false}
                          value={reference}
                          placeholder="registry.example/extension:version"
                          tooltip={
                            reference || 'Paste a full OCI image reference; press Enter to inspect'
                          }
                          width={{ chars: 24 }}
                          onChange={(event: Change) =>
                            setReference(String(event.value ?? '').slice(0, 512))
                          }
                          onSubmit={() => inspect()}
                        />
                        <Button
                          label={busy === 'inspect' ? 'Inspecting…' : 'Inspect'}
                          variant="filled"
                          tone="accent"
                          enabled={Boolean(reference.trim()) && !busy}
                          onInvoke={() => inspect()}
                        />
                      </Row>
                      <Text
                        label="Paste an OCI image reference. You’ll review compatibility and requested access before installation."
                        color="text-dim"
                        wrap
                      />
                    </CardContent>
                  </Card>
                </Expander>
              ) : (
                <Card grow={false} width="fill" variant="outline">
                  {!acquisition.candidate ? (
                    <CardHeader
                      label={
                        acquisition.state === 'failed'
                          ? 'Couldn’t inspect extension'
                          : acquisition.state === 'cancelled'
                            ? 'Inspection cancelled'
                            : 'Inspecting extension'
                      }
                      detail="Image inspection"
                      align="start"
                      width="fill"
                    />
                  ) : null}
                  {acquisition?.candidate && (
                    <CardContent gap={1}>
                      <AcquisitionIdentity
                        acquisition={{ ...acquisition, candidate: acquisition.candidate }}
                        catalogueEntry={catalogueExpectation}
                        expanded={identityDetailsExpanded}
                        onExpandedChange={setIdentityDetailsExpanded}
                      />
                      {identityReviewWarning ? (
                        <InlineMessage label={identityReviewWarning} tone="warning" />
                      ) : null}
                      {catalogueMismatch ? (
                        <RecoveryState
                          operation="Catalogue verification"
                          error={`${catalogueMismatch} Return to the catalogue and review its latest entry before installing.`}
                          retryLabel="Back to catalogue"
                          onRetry={backToCatalogue}
                        />
                      ) : null}
                      <RequestedPermissionSummary groups={requestedPermissionGroups} />
                      <Text
                        label="Access starts off. Review exact grants and enable only what this extension needs."
                        color="text-dim"
                        wrap
                      />
                      {missingRequiredCapabilities.length > 0 ? (
                        <Column gap={1} align="start">
                          <InlineMessage
                            label={`${countLabel(missingRequiredCapabilities.length, 'required permission')} ${missingRequiredCapabilities.length === 1 ? 'is' : 'are'} off: ${missingRequiredCapabilities.map(capabilityLabel).join(', ')}. Optional access stays off.`}
                            tone="warning"
                          />
                          <Button
                            label="Select required access"
                            tooltip="Enable only the permissions required for this extension to remain available"
                            size="small"
                            variant="outline"
                            tone="neutral"
                            enabled={!busy}
                            onInvoke={() =>
                              setGranted((current) => [
                                ...new Set([...current, ...requiredCapabilities]),
                              ])
                            }
                          />
                        </Column>
                      ) : null}
                      {privilegedAccessWarning ? (
                        <InlineMessage label={privilegedAccessWarning} tone="warning" />
                      ) : null}
                      <Expander
                        label={`Exact grants · ${grantedPermissionCount}/${requestedPermissionCount} selected`}
                        expanded={permissionDetailsExpanded}
                        onExpand={(event: Change) =>
                          setPermissionDetailsExpanded(Boolean(event.value))
                        }
                      >
                        <Column gap={1} pad={{ bottom: 18 }}>
                          {acquisition.candidate.requested.length > 0 && (
                            <Row gap={1} width="fill" align="center" justify="stretch">
                              <Text
                                label={`Product access · ${granted.length}/${acquisition.candidate.requested.length}`}
                                color="text-dim"
                              />
                              <Spacer />
                              <Button
                                label="Clear product access"
                                size="small"
                                variant="ghost"
                                enabled={!busy && granted.length > 0}
                                onInvoke={() => {
                                  setGranted([]);
                                }}
                              />
                            </Row>
                          )}
                          {acquisition.candidate.requested.map((capability) => (
                            <FormControlLabel
                              key={capability}
                              label={`${capabilityLabel(capability)}${requiredCapabilities.includes(capability) ? ' · Required' : ''}`}
                              tooltip={capability}
                              gap={2}
                            >
                              <Switch
                                checked={granted.includes(capability)}
                                onToggle={(event: Change) => {
                                  const enabled = Boolean(event.value);
                                  setGranted((current) =>
                                    withCapability(current, capability, enabled),
                                  );
                                  if (!enabled && capability === 'workspace-environment:read')
                                    setGrantedWorkspaceEnvironment((current) => ({
                                      ...current,
                                      read: [],
                                    }));
                                  if (!enabled && capability === 'workspace-environment:write')
                                    setGrantedWorkspaceEnvironment((current) => ({
                                      ...current,
                                      write: [],
                                    }));
                                  if (!enabled && capability === 'filesystem:read')
                                    setGrantedFilesystem((current) => ({ ...current, read: [] }));
                                  if (!enabled && capability === 'filesystem:write')
                                    setGrantedFilesystem((current) => ({
                                      ...current,
                                      write: [],
                                      create: [],
                                      delete: [],
                                      rename: [],
                                    }));
                                  if (!enabled && capability === 'images:read')
                                    setGrantedImages((current) => ({ ...current, read: [] }));
                                  if (!enabled && capability === 'images:pull')
                                    setGrantedImages((current) => ({ ...current, pull: [] }));
                                  if (!enabled && capability === 'images:remove')
                                    setGrantedImages((current) => ({ ...current, remove: [] }));
                                  if (!enabled && capability === 'images:prune')
                                    setGrantedImages((current) => ({
                                      ...current,
                                      prune_all_unused: false,
                                    }));
                                  if (!enabled && capability === 'containers:create') {
                                    setGrantedImages((current) => ({ ...current, use: [] }));
                                    setGrantedContainers((current) => ({
                                      ...current,
                                      create: false,
                                    }));
                                  }
                                  if (!enabled && capability === 'networks:create')
                                    setGrantedNetworks((current) => ({
                                      ...current,
                                      create: false,
                                    }));
                                  if (!enabled && capability === 'volumes:write')
                                    setGrantedVolumes((current) => ({ ...current, create: false }));
                                }}
                              />
                            </FormControlLabel>
                          ))}
                          {(requestedContainers.selectors.length > 0 ||
                            requestedContainers.create) && (
                            <>
                              <Text
                                label={`Container access · ${grantedContainers.selectors.length + Number(grantedContainers.create)}/${requestedContainers.selectors.length + Number(requestedContainers.create)}`}
                                color="text-dim"
                              />
                              <Text
                                label="Container access starts off. Select only what this extension needs."
                                color="text-dim"
                                wrap
                              />
                            </>
                          )}
                          {requestedContainers.selectors.map((selector) => {
                            const key = selectorKey(selector);
                            const selected = grantedContainers.selectors.some(
                              (candidate) => selectorKey(candidate) === key,
                            );
                            return (
                              <FormControlLabel key={key} label={selectorLabel(selector)} gap={2}>
                                <Switch
                                  checked={selected}
                                  onToggle={(event: Change) =>
                                    setGrantedContainers((current) => ({
                                      ...current,
                                      selectors: event.value
                                        ? current.selectors.some(
                                            (candidate) => selectorKey(candidate) === key,
                                          )
                                          ? current.selectors
                                          : [...current.selectors, selector]
                                        : current.selectors.filter(
                                            (candidate) => selectorKey(candidate) !== key,
                                          ),
                                    }))
                                  }
                                />
                              </FormControlLabel>
                            );
                          })}
                          {requestedContainers.create && (
                            <FormControlLabel label="Create new containers" gap={2}>
                              <Switch
                                checked={grantedContainers.create}
                                onToggle={(event: Change) => {
                                  const enabled = Boolean(event.value);
                                  setGranted((current) =>
                                    withCapability(
                                      current,
                                      'containers:create',
                                      enabled || grantedImages.use.length > 0,
                                    ),
                                  );
                                  setGrantedContainers((current) => ({
                                    ...current,
                                    create: enabled,
                                  }));
                                }}
                              />
                            </FormControlLabel>
                          )}
                          {imageGrantCount(requestedImages) > 0 && (
                            <>
                              <Text
                                label={`Image access · ${imageGrantCount(grantedImages)}/${imageGrantCount(requestedImages)}`}
                                color="text-dim"
                              />
                              <Text
                                label="Each image switch includes only the matching product action."
                                color="text-dim"
                                wrap
                              />
                            </>
                          )}
                          {IMAGE_VERBS.flatMap(({ key: verb, label }) =>
                            requestedImages[verb].map((selector) => {
                              const key = imageSelectorKey(selector);
                              const selected = grantedImages[verb].some(
                                (candidate) => imageSelectorKey(candidate) === key,
                              );
                              return (
                                <FormControlLabel
                                  key={`${verb}:${key}`}
                                  label={`${label} · ${imageSelectorLabel(selector)}`}
                                  gap={2}
                                >
                                  <Switch
                                    checked={selected}
                                    onToggle={(event: Change) => {
                                      const next = {
                                        ...grantedImages,
                                        [verb]: event.value
                                          ? grantedImages[verb].some(
                                              (candidate) => imageSelectorKey(candidate) === key,
                                            )
                                            ? grantedImages[verb]
                                            : [...grantedImages[verb], selector]
                                          : grantedImages[verb].filter(
                                              (candidate) => imageSelectorKey(candidate) !== key,
                                            ),
                                      };
                                      const capability = imageCapability(verb);
                                      const enabled =
                                        next[verb].length > 0 ||
                                        (capability === 'containers:create' &&
                                          grantedContainers.create);
                                      setGranted((current) =>
                                        withCapability(current, capability, enabled),
                                      );
                                      setGrantedImages(next);
                                    }}
                                  />
                                </FormControlLabel>
                              );
                            }),
                          )}
                          {requestedImages.prune_all_unused && (
                            <FormControlLabel label="Prune every unused image" gap={2}>
                              <Switch
                                checked={grantedImages.prune_all_unused}
                                onToggle={(event: Change) => {
                                  const enabled = Boolean(event.value);
                                  setGranted((current) =>
                                    withCapability(current, 'images:prune', enabled),
                                  );
                                  setGrantedImages((current) => ({
                                    ...current,
                                    prune_all_unused: enabled,
                                  }));
                                }}
                              />
                            </FormControlLabel>
                          )}
                          {(requestedNetworks.selectors.length > 0 || requestedNetworks.create) && (
                            <>
                              <Text
                                label={`Network access · ${grantedNetworks.selectors.length + Number(grantedNetworks.create)}/${requestedNetworks.selectors.length + Number(requestedNetworks.create)}`}
                                color="text-dim"
                              />
                              <Text
                                label="Network access starts off. Select only the networks this extension needs."
                                color="text-dim"
                                wrap
                              />
                            </>
                          )}
                          {requestedNetworks.selectors.map((selector) => {
                            const key = networkSelectorKey(selector);
                            const selected = grantedNetworks.selectors.some(
                              (candidate) => networkSelectorKey(candidate) === key,
                            );
                            return (
                              <FormControlLabel
                                key={key}
                                label={networkSelectorLabel(selector)}
                                gap={2}
                              >
                                <Switch
                                  checked={selected}
                                  onToggle={(event: Change) =>
                                    setGrantedNetworks((current) => ({
                                      ...current,
                                      selectors: event.value
                                        ? current.selectors.some(
                                            (candidate) => networkSelectorKey(candidate) === key,
                                          )
                                          ? current.selectors
                                          : [...current.selectors, selector]
                                        : current.selectors.filter(
                                            (candidate) => networkSelectorKey(candidate) !== key,
                                          ),
                                    }))
                                  }
                                />
                              </FormControlLabel>
                            );
                          })}
                          {requestedNetworks.create && (
                            <FormControlLabel label="Create new networks" gap={2}>
                              <Switch
                                checked={grantedNetworks.create}
                                onToggle={(event: Change) => {
                                  const enabled = Boolean(event.value);
                                  setGranted((current) =>
                                    withCapability(current, 'networks:create', enabled),
                                  );
                                  setGrantedNetworks((current) => ({
                                    ...current,
                                    create: enabled,
                                  }));
                                }}
                              />
                            </FormControlLabel>
                          )}
                          {(requestedVolumes.selectors.length > 0 || requestedVolumes.create) && (
                            <Text
                              label={`Volume access · ${grantedVolumes.selectors.length + Number(grantedVolumes.create)}/${requestedVolumes.selectors.length + Number(requestedVolumes.create)}`}
                              color="text-dim"
                            />
                          )}
                          {requestedVolumes.selectors.map((selector) => {
                            const key = volumeSelectorKey(selector);
                            const selected = grantedVolumes.selectors.some(
                              (candidate) => volumeSelectorKey(candidate) === key,
                            );
                            return (
                              <FormControlLabel
                                key={key}
                                label={volumeSelectorLabel(selector)}
                                gap={2}
                              >
                                <Switch
                                  checked={selected}
                                  onToggle={(event: Change) =>
                                    setGrantedVolumes((current) => ({
                                      ...current,
                                      selectors: event.value
                                        ? [
                                            ...current.selectors.filter(
                                              (candidate) => volumeSelectorKey(candidate) !== key,
                                            ),
                                            selector,
                                          ]
                                        : current.selectors.filter(
                                            (candidate) => volumeSelectorKey(candidate) !== key,
                                          ),
                                    }))
                                  }
                                />
                              </FormControlLabel>
                            );
                          })}
                          {requestedVolumes.create && (
                            <FormControlLabel label="Create new volumes" gap={2}>
                              <Switch
                                checked={grantedVolumes.create}
                                onToggle={(event: Change) => {
                                  const enabled = Boolean(event.value);
                                  setGranted((current) =>
                                    withCapability(current, 'volumes:write', enabled),
                                  );
                                  setGrantedVolumes((current) => ({ ...current, create: enabled }));
                                }}
                              />
                            </FormControlLabel>
                          )}
                          {filesystemGrantCount(requestedFilesystem) > 0 && (
                            <>
                              <Text label="Workspace files" color="text-dim" />
                              <FilesystemConsent
                                requested={requestedFilesystem}
                                granted={grantedFilesystem}
                                onChange={setGrantedFilesystem}
                                onCapabilityChange={(capability, enabled) =>
                                  setGranted((current) =>
                                    withCapability(current, capability, enabled),
                                  )
                                }
                              />
                            </>
                          )}
                          {(requestedWorkspaceEnvironment.read.length > 0 ||
                            requestedWorkspaceEnvironment.write.length > 0) && (
                            <Text
                              label={`Workspace environment values · ${grantedWorkspaceEnvironment.read.length + grantedWorkspaceEnvironment.write.length}/${requestedWorkspaceEnvironment.read.length + requestedWorkspaceEnvironment.write.length}`}
                              color="text-dim"
                            />
                          )}
                          {(['read', 'write'] as const).flatMap((verb) =>
                            requestedWorkspaceEnvironment[verb].map((selector) => {
                              const key = `${verb}:${'all' in selector ? 'all' : `${selector.workspace}:${selector.name}`}`;
                              const checked = grantedWorkspaceEnvironment[verb].some(
                                (candidate) =>
                                  JSON.stringify(candidate) === JSON.stringify(selector),
                              );
                              return (
                                <FormControlLabel
                                  key={key}
                                  label={
                                    'all' in selector
                                      ? `${verb === 'read' ? 'Read' : 'Change'} all workspace environment values`
                                      : `${verb === 'read' ? 'Read' : 'Change'} ${selector.name} in workspace ${selector.workspace}`
                                  }
                                  gap={2}
                                >
                                  <Switch
                                    checked={checked}
                                    onToggle={(event: Change) => {
                                      const enabled = Boolean(event.value);
                                      const selected = enabled
                                        ? [...grantedWorkspaceEnvironment[verb], selector]
                                        : grantedWorkspaceEnvironment[verb].filter(
                                            (candidate) =>
                                              JSON.stringify(candidate) !==
                                              JSON.stringify(selector),
                                          );
                                      setGrantedWorkspaceEnvironment((current) => ({
                                        ...current,
                                        [verb]: selected,
                                      }));
                                      setGranted((capabilities) =>
                                        withCapability(
                                          capabilities,
                                          verb === 'read'
                                            ? 'workspace-environment:read'
                                            : 'workspace-environment:write',
                                          selected.length > 0,
                                        ),
                                      );
                                    }}
                                  />
                                </FormControlLabel>
                              );
                            }),
                          )}
                          {requestedCredentials.read.length +
                            requestedCredentials.write.length +
                            requestedCredentials.expose_to_execution.length >
                            0 && (
                            <>
                              <Text label="Credential access" color="text-dim" />
                              <Text
                                label="Credentials may contain reusable secrets. Grant only the exact values this extension needs."
                                color="text-dim"
                                wrap
                                width={COPY_WIDTH}
                              />
                              {requestedCredentials.expose_to_execution.length > 0 && (
                                <Text
                                  label="A launched process and this extension can read, print, or persist every exposed secret."
                                  color="warning"
                                  wrap
                                  width={COPY_WIDTH}
                                />
                              )}
                            </>
                          )}
                          {(['read', 'write', 'expose_to_execution'] as const).flatMap(
                            (operation) =>
                              requestedCredentials[operation].map((key) => {
                                const checked = grantedCredentials[operation].includes(key);
                                const capability = (
                                  operation === 'expose_to_execution'
                                    ? 'credentials:expose-to-execution'
                                    : `credentials:${operation}`
                                ) as ExtensionCapability;
                                return (
                                  <FormControlLabel
                                    key={`${operation}:${key}`}
                                    label={`${operation === 'read' ? 'Read' : operation === 'write' ? 'Change' : 'Expose to launched process'} credential ${key}`}
                                    gap={2}
                                  >
                                    <Switch
                                      checked={checked}
                                      onToggle={(event: Change) => {
                                        const selected = event.value
                                          ? [...grantedCredentials[operation], key]
                                          : grantedCredentials[operation].filter(
                                              (candidate) => candidate !== key,
                                            );
                                        setGrantedCredentials((current) => ({
                                          ...current,
                                          [operation]: selected,
                                        }));
                                        setGranted((current) =>
                                          withCapability(current, capability, selected.length > 0),
                                        );
                                      }}
                                    />
                                  </FormControlLabel>
                                );
                              }),
                          )}
                          <Spacer height={6} />
                        </Column>
                      </Expander>
                    </CardContent>
                  )}
                  {acquisition && acquisition.state !== 'ready' && (
                    <CardContent gap={1}>
                      <Text
                        label={`Source ${compactImageReference(acquisition.reference)}`}
                        color="text-dim"
                        tooltip={acquisition.reference}
                        wrap
                      />
                      {acquisition.state === 'failed' ? (
                        <Column gap={1}>
                          <InlineMessage
                            label={acquisitionFailure(
                              acquisition.error ?? 'The image could not be inspected.',
                              catalogueExpectation,
                            )}
                            tone="danger"
                            width={COPY_WIDTH}
                          />
                          <Row gap={2} wrap>
                            <Button
                              label="Retry inspection"
                              size="small"
                              variant="filled"
                              tone="accent"
                              enabled={!busy}
                              onInvoke={() => inspect(reference, catalogueExpectation)}
                            />
                            {isAcquisitionAuthenticationFailure(acquisition.error) &&
                            !isVerifiedFirstPartyCatalogueEntry(catalogueExpectation) &&
                            onOpenWorkspaceSettings ? (
                              <Button
                                label="Open workspace settings"
                                size="small"
                                variant="outline"
                                enabled={!busy}
                                onInvoke={onOpenWorkspaceSettings}
                              />
                            ) : null}
                            <Button
                              label="Back to catalogue"
                              size="small"
                              variant="ghost"
                              enabled={!busy}
                              onInvoke={backToCatalogue}
                            />
                          </Row>
                          <Expander label="Technical details" expanded={false} width="fill">
                            <Text
                              label={acquisitionTechnicalDetail(
                                acquisition.error ?? 'The image could not be inspected.',
                              )}
                              wrap
                            />
                          </Expander>
                        </Column>
                      ) : acquisition.state === 'cancelled' ? (
                        <Column gap={1}>
                          <Text label={acquisitionLabel(acquisition)} color="text-dim" wrap />
                          <Button
                            label="Back to catalogue"
                            size="small"
                            variant="ghost"
                            enabled={!busy}
                            onInvoke={backToCatalogue}
                          />
                        </Column>
                      ) : acquisition.state === 'committing' ? (
                        <Row gap={1} align="center" wrap>
                          <Spinner />
                          <Text label={acquisitionLabel(acquisition)} wrap />
                        </Row>
                      ) : ['installed', 'updated'].includes(acquisition.state) ? (
                        <Column gap={1} align="start">
                          <Text label={acquisitionLabel(acquisition)} wrap />
                          <Button
                            label="Verify in installed extensions"
                            size="small"
                            variant="filled"
                            tone="accent"
                            enabled={!busy && Boolean(acquisition.candidate)}
                            onInvoke={verifyCommittedAcquisition}
                          />
                        </Column>
                      ) : (
                        <AcquisitionProgressAction
                          acquisition={acquisition}
                          cancelling={busy === 'cancel'}
                          onCancel={cancel}
                        />
                      )}
                    </CardContent>
                  )}
                </Card>
              )}
            </Column>
          ) : (
            <Column gap={2} width="fill" height="content">
              <Row gap={1} width="fill" align="center" justify="stretch">
                <Row gap={1} align="center" wrap>
                  <Heading
                    label="Installed extensions"
                    scale="caption"
                    grow={false}
                    align="start"
                  />
                  {inventoryState !== 'loading' ? (
                    <Badge label={countLabel(installed.length, 'extension')} />
                  ) : null}
                </Row>
                <Spacer />
                <Button
                  label="Refresh"
                  tooltip="Refresh installed extensions"
                  icon="view-refresh-symbolic"
                  size="small"
                  variant="ghost"
                  enabled={!busy && inventoryState !== 'loading'}
                  onInvoke={reload}
                />
              </Row>
              {watchError && (
                <RecoveryState
                  operation="Extension updates"
                  error={watchError}
                  retryLabel="Refresh extensions"
                  onRetry={reload}
                />
              )}
              {inventoryState === 'ready' ? (
                <Column gap={1} width="fill">
                  <Text label="Find installed extensions" color="text-dim" />
                  <Row gap={1} width="fill" wrap align="center" justify="start">
                    <Search
                      grow
                      value={installedQuery}
                      placeholder="Search installed"
                      tooltip="Search by extension name, runtime status, or interface provider"
                      width={{ minimum: { chars: 18 }, maximum: { chars: 36 } }}
                      onChange={(event: Change) => {
                        setInstalledQuery(String(event.value ?? '').slice(0, 128));
                        setInstalledLimit(INSTALLED_PAGE_SIZE);
                      }}
                    />
                    <Select
                      value={installedFilter}
                      tooltip="Filter installed extensions by status"
                      width={{ minimum: { chars: 22 }, maximum: { chars: 22 } }}
                      choices={[
                        { value: 'all', label: 'All installed' },
                        { value: 'running', label: 'Running' },
                        { value: 'faulted', label: 'Faulted' },
                        { value: 'updates', label: 'Updates' },
                        { value: 'disabled', label: 'Disabled' },
                      ]}
                      onChange={(event: Change) => {
                        const selected = String(event.value ?? '');
                        if (
                          ['all', 'running', 'faulted', 'updates', 'disabled'].includes(selected)
                        ) {
                          setInstalledFilter(selected as InstalledFilter);
                          setInstalledLimit(INSTALLED_PAGE_SIZE);
                        }
                      }}
                    />
                    {visibleInstalled.length > renderedInstalled.length ? (
                      <Button
                        label={`Show ${Math.min(INSTALLED_PAGE_SIZE, visibleInstalled.length - renderedInstalled.length)} more · ${visibleInstalled.length - renderedInstalled.length} remaining`}
                        icon="go-down-symbolic"
                        size="small"
                        variant="outline"
                        onInvoke={() =>
                          setInstalledLimit((current) => current + INSTALLED_PAGE_SIZE)
                        }
                      />
                    ) : (
                      <Text
                        label={`${visibleInstalled.length} of ${countLabel(installed.length, 'installed extension')}`}
                        color="text-dim"
                      />
                    )}
                  </Row>
                </Column>
              ) : null}
              <ResourceState
                state={inventoryState}
                loadingLabel="Loading installed extensions…"
                emptyLabel="No extensions installed"
                emptyDetail="Choose an extension or inspect an OCI image."
                error={inventoryError || 'Installed extensions could not be loaded.'}
                onRetry={reload}
              >
                {visibleInstalled.length === 0 ? (
                  <Column gap={1} align="start">
                    <InlineMessage
                      label="No installed extensions match this search and status filter."
                      tone="neutral"
                    />
                    <Button
                      label="Clear installed filters"
                      size="small"
                      onInvoke={() => {
                        setInstalledQuery('');
                        setInstalledFilter('all');
                        setInstalledLimit(INSTALLED_PAGE_SIZE);
                      }}
                    />
                  </Column>
                ) : (
                  <Column gap={2} width="fill">
                    {[
                      { attention: true, label: 'Needs attention' },
                      { attention: false, label: 'Healthy extensions' },
                    ].map(({ attention, label }) => {
                      const extensions = renderedInstalled.filter(
                        (extension) =>
                          installedExtensionNeedsAttention(extension, catalogueEntries) ===
                          attention,
                      );
                      if (extensions.length === 0) return null;
                      return (
                        <Column key={label} gap={1} width="fill">
                          <Row gap={1} width="fill" align="center" justify="start">
                            <Heading label={label} scale="caption" grow={false} align="start" />
                            <Badge label={countLabel(extensions.length, 'extension')} />
                          </Row>
                          {(() => {
                            const cards = (fullWidth: boolean, layout: string) =>
                              extensions.map((extension) => {
                                const catalogueEntry = catalogue?.entries.find(
                                  (entry) => entry.id === extension.name,
                                );
                                const builtIn = extension.name === 'top';
                                const faulted = extension.status.startsWith('fault:');
                                const retrying =
                                  pendingLifecycle?.name === extension.name &&
                                  pendingLifecycle.action === 'retry';
                                const update =
                                  !builtIn &&
                                  catalogueEntry &&
                                  catalogueUpdateAvailable(catalogueEntry, extension)
                                    ? catalogueEntry
                                    : undefined;
                                const updateCompatibility = update
                                  ? catalogueCompatibility(update, workspaceArchitecture)
                                  : null;
                                const currentCompatibility = catalogueEntry
                                  ? catalogueCompatibility(catalogueEntry, workspaceArchitecture)
                                  : null;
                                const identityTrust = catalogueEntry
                                  ? catalogueTrust(
                                      catalogueAuthoritative
                                        ? catalogueEntry
                                        : { ...catalogueEntry, publisher_verified: false },
                                    )
                                  : null;
                                const provider = extension.pane_providers?.[0];
                                const hasCardAction = Boolean(
                                  update ||
                                  (!builtIn && (!extension.enabled || catalogueEntry)) ||
                                  provider,
                                );
                                return (
                                  <Card
                                    key={`${layout}:${extension.name}:${extension.image_digest}`}
                                    width={
                                      fullWidth
                                        ? 'fill'
                                        : { minimum: { chars: 36 }, maximum: 'fill' }
                                    }
                                    height="content"
                                    variant="outline"
                                  >
                                    <CardContent gap={1}>
                                      <Row gap={1} width="fill" align="center" justify="start" wrap>
                                        <Column gap={0} grow>
                                          <Text
                                            label={catalogueEntry?.title ?? extension.name}
                                            tooltip={extension.image_digest}
                                          />
                                          <Text
                                            label={`${catalogueEntry && catalogueEntry.title !== extension.name ? `${extension.name} · ` : ''}${
                                              extension.version
                                                ? `Version ${extension.version}`
                                                : 'Version unavailable'
                                            }`}
                                            color="text-dim"
                                          />
                                        </Column>
                                        <Badge
                                          label={capitalize(extensionState(extension))}
                                          tone={
                                            faulted
                                              ? 'danger'
                                              : extension.enabled
                                                ? 'positive'
                                                : 'neutral'
                                          }
                                        />
                                        {builtIn ? <Badge label="Built-in" tone="accent" /> : null}
                                        {catalogueEntry && identityTrust ? (
                                          <Badge
                                            {...identityTrust}
                                            label={`${catalogueEntry.publisher} · ${
                                              identityTrust.label === 'Verified publisher'
                                                ? 'Verified'
                                                : 'Unverified'
                                            }`}
                                          />
                                        ) : null}
                                        {!update && extension.name !== 'top' && faulted ? (
                                          <Button
                                            key="lifecycle"
                                            label={retrying ? 'Retrying…' : 'Retry'}
                                            variant="filled"
                                            tone={retrying ? 'neutral' : 'accent'}
                                            size="small"
                                            enabled={!busy}
                                            onInvoke={() => lifecycle(extension, 'retry')}
                                          />
                                        ) : null}
                                      </Row>
                                      {builtIn ? (
                                        <Text
                                          label="Top is managed by Husklet and stays available for workspace recovery."
                                          color="text-dim"
                                          wrap
                                        />
                                      ) : null}
                                      <ExtensionFault extension={extension} />
                                      {updateCompatibility ? (
                                        <Text
                                          label={
                                            update
                                              ? updateCompatibility.compatible === true
                                                ? `Update available · Version ${update.version}`
                                                : `Update to Version ${update.version} · ${updateCompatibility.label}`
                                              : `Update · ${updateCompatibility.label}`
                                          }
                                          color={
                                            updateCompatibility.compatible === false
                                              ? 'warning'
                                              : 'text-dim'
                                          }
                                          wrap
                                        />
                                      ) : null}
                                      <LifecycleFeedback
                                        extensionName={extension.name}
                                        pending={pendingLifecycle}
                                        failure={lifecycleFailure}
                                      />
                                      {extension.name === 'top' ? (
                                        <InstalledPermissionSummary extension={extension} />
                                      ) : (
                                        <Expander label="View permissions" expanded={false}>
                                          <InstalledPermissionSummary extension={extension} />
                                        </Expander>
                                      )}
                                      {hasCardAction || extension.name !== 'top' ? (
                                        <Row
                                          gap={2}
                                          width="fill"
                                          align="center"
                                          justify="start"
                                          wrap
                                        >
                                          {update && (
                                            <Button
                                              key="review-update"
                                              label="Review update"
                                              size="small"
                                              variant="filled"
                                              tone="accent"
                                              enabled={
                                                workspaceIdentityState === 'ready' &&
                                                !busy &&
                                                updateCompatibility?.compatible !== false
                                              }
                                              onInvoke={() => inspect(update.reference, update)}
                                            />
                                          )}
                                          {!update &&
                                          extension.name !== 'top' &&
                                          !extension.enabled ? (
                                            <InlineButton
                                              key="lifecycle"
                                              label="Enable"
                                              variant="outline"
                                              tone="neutral"
                                              enabled={!busy}
                                              onInvoke={() => lifecycle(extension, 'enable')}
                                            />
                                          ) : extension.enabled && provider ? (
                                            providerAction(extension, provider)
                                          ) : null}
                                          {!builtIn && !update && catalogueEntry ? (
                                            <Button
                                              label="Check for changes"
                                              tooltip={`Check ${extension.name} image for changes`}
                                              size="small"
                                              variant="ghost"
                                              enabled={
                                                workspaceIdentityState === 'ready' &&
                                                !busy &&
                                                currentCompatibility?.compatible !== false
                                              }
                                              onInvoke={() =>
                                                inspect(catalogueEntry.reference, catalogueEntry)
                                              }
                                            />
                                          ) : null}
                                          {!builtIn &&
                                          extension.enabled &&
                                          !extension.status.startsWith('fault:') ? (
                                            <Button
                                              label="Disable"
                                              size="small"
                                              variant="outline"
                                              tone="neutral"
                                              enabled={!busy}
                                              onInvoke={() => lifecycle(extension, 'disable')}
                                            />
                                          ) : null}
                                        </Row>
                                      ) : null}
                                      {!builtIn ? (
                                        <Column
                                          width="fill"
                                          align="start"
                                          pad={{ top: faulted ? 1 : 0 }}
                                        >
                                          <Expander
                                            label="Remove extension…"
                                            expanded={removalMenu === extension.name}
                                            variant="outline"
                                            width="content"
                                            height={{ step: 11 }}
                                            align="start"
                                            justify="center"
                                            tooltip={`Remove ${extension.name}`}
                                            onExpand={(event: Change) =>
                                              setRemovalMenu(
                                                (event.expanded ?? event.value)
                                                  ? extension.name
                                                  : '',
                                              )
                                            }
                                          >
                                            <Column
                                              gap={1}
                                              width="fill"
                                              align="start"
                                              pad={{ top: 2 }}
                                            >
                                              <ConfirmAction
                                                label="Remove extension"
                                                confirmLabel={`Remove ${extension.name}`}
                                                question={extensionRemovalQuestion(extension.name)}
                                                authorityKey={extension.image_digest}
                                                enabled={!busy}
                                                size="small"
                                                onConfirm={() => lifecycle(extension, 'remove')}
                                              />
                                            </Column>
                                          </Expander>
                                        </Column>
                                      ) : null}
                                    </CardContent>
                                  </Card>
                                );
                              });
                            return attention ? (
                              <Responsive alternate breakpoint={760} width="fill">
                                <Column gap={1} width="fill">
                                  {cards(true, 'narrow')}
                                </Column>
                                <Row gap={1} width="fill" wrap align="start">
                                  {cards(false, 'wide')}
                                </Row>
                              </Responsive>
                            ) : (
                              <Row gap={1} width="fill" wrap>
                                {cards(false, 'healthy')}
                              </Row>
                            );
                          })()}
                        </Column>
                      );
                    })}
                  </Column>
                )}
              </ResourceState>
            </Column>
          )}
        </Column>
      </Container>
    </Scroll>
  );
  return (
    <Column grow gap={0}>
      {content}
      {acquisition?.candidate ? (
        <Column gap={0} grow={false}>
          <Spacer height={1} />
          <Separator orientation="horizontal" />
          <Column gap={0} width="fill" pad={{ end: 4, start: 4 }}>
            <Spacer height={1} />
            <Text
              label={
                requestedPermissionCount > 0 && grantedPermissionCount === 0
                  ? `No access selected · ${requestedPermissionCount} requested`
                  : `Review decision · ${grantedPermissionCount}/${requestedPermissionCount} selected`
              }
              color="text-dim"
              wrap={false}
            />
            <ReviewActions
              busy={busy}
              updating={Boolean(acquisition.candidate.installed_image_digest)}
              enabled={
                acquisition.state === 'ready' &&
                missingRequiredCapabilities.length === 0 &&
                !catalogueMismatch
              }
              onPublish={publish}
              onCancel={dismissReview}
            />
            <Spacer height={1} />
          </Column>
        </Column>
      ) : null}
    </Column>
  );
}

function ReviewActions({
  busy,
  updating,
  enabled,
  onPublish,
  onCancel,
}: {
  busy: string | null;
  updating: boolean;
  enabled: boolean;
  onPublish: () => void;
  onCancel: () => void;
}) {
  return (
    <Row gap={1} align="center" justify="end" width="fill">
      <Button
        label={
          busy === 'update'
            ? 'Updating…'
            : busy === 'install'
              ? 'Installing…'
              : updating
                ? 'Update with selected access'
                : 'Install with selected access'
        }
        size="small"
        enabled={!busy && enabled}
        variant="filled"
        tone="accent"
        onInvoke={onPublish}
      />
      <Button
        label="Cancel review"
        size="small"
        variant="ghost"
        enabled={!busy}
        onInvoke={onCancel}
      />
    </Row>
  );
}

export function lifecycleReconciliationFailure(operation: string, verification: string): string {
  return `${operation} Current extension state could not be verified: ${verification}`;
}

function AcquisitionProgressAction({
  acquisition,
  cancelling,
  onCancel,
}: {
  acquisition: ExtensionAcquisitionStatus;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const progress = acquisition.progress;
  const fraction = acquisitionProgressFraction(acquisition);
  const stage = progress
    ? `${progress.status}${progress.id ? ` · ${progress.id}` : ''}`
    : acquisitionLabel(acquisition);
  const value =
    progress?.current == null
      ? ''
      : progress.total == null
        ? `${progress.current} bytes`
        : `${progress.current}/${progress.total} bytes · ${Math.round((fraction ?? 0) * 100)}%`;
  return (
    <Column gap={1} width={{ chars: 75 }} align="start">
      <Row gap={1} width="fill" align="center" justify="stretch">
        <Text label={stage} wrap grow />
        {value ? <Text label={value} color="text-dim" /> : null}
      </Row>
      <Row gap={3} width={{ chars: 75 }} align="center" justify="center" wrap>
        {progress ? (
          <Row grow width="fill" justify="center">
            <Progress
              fraction={fraction}
              tooltip={acquisitionLabel(acquisition)}
              width="fill"
              justify="center"
            />
          </Row>
        ) : (
          <Spinner />
        )}
        <Button
          label={cancelling ? 'Cancelling…' : 'Cancel inspection'}
          variant="outline"
          size="medium"
          align="end"
          justify="center"
          enabled={!cancelling}
          onInvoke={onCancel}
        />
      </Row>
    </Column>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500);
}

function extensionCommitConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const failure = cause as { kind?: unknown; cause?: unknown };
  return failure.kind === 'conflict' || extensionCommitConflict(failure.cause);
}

export function acquisitionConnectionFailure(cause: unknown): string {
  const detail = message(cause);
  const failure = cause && typeof cause === 'object' ? (cause as { kind?: unknown }) : null;
  if (
    failure?.kind === 'absent' ||
    /extension acquisition .*\b(absent|not found|does not exist)\b/i.test(detail)
  ) {
    return 'This inspection session ended when the workspace service restarted. Retry inspection; nothing was installed.';
  }
  if (/four extension acquisitions are already active/i.test(detail)) {
    return 'Four image inspections are already active. Finish or cancel one, then retry.';
  }
  if (/acquisition history is full/i.test(detail)) {
    return 'Inspection history is full. Reopen the workspace, then retry.';
  }
  if (/image reference|reference must|must contain 1 to 512 bytes/i.test(detail)) return detail;
  if (/closed|socket|connection|ECONN|timed? ?out/i.test(detail)) {
    return 'The connection closed before inspection finished. Retry inspection to resume its current job when possible; nothing is installed without your review.';
  }
  return 'Inspection could not be started. Reopen the workspace, verify the image reference, then retry.';
}

function selectorKey(selector: ContainerSelector): string {
  if ('all' in selector) return 'all';
  if ('id' in selector) return `id:${selector.id}`;
  return `name:${selector.name}`;
}

function selectorLabel(selector: ContainerSelector): string {
  if ('all' in selector) return 'Every workspace container · broad access';
  if ('id' in selector) return `One container · exact ID ${selector.id}`;
  return `One container · name ${selector.name}`;
}

function networkSelectorKey(selector: NetworkSelector): string {
  if ('all' in selector) return 'all';
  if ('id' in selector) return `id:${selector.id}`;
  return `name:${selector.name}`;
}

function networkSelectorLabel(selector: NetworkSelector): string {
  if ('all' in selector) return 'Every workspace network · broad access';
  if ('id' in selector) return `One network · exact ID ${selector.id}`;
  return `One network · name ${selector.name}`;
}

function volumeSelectorKey(selector: VolumeSelector): string {
  return 'all' in selector ? 'all' : `name:${selector.name}`;
}

function volumeSelectorLabel(selector: VolumeSelector): string {
  return 'all' in selector
    ? 'Every workspace volume · broad access'
    : `One volume · name ${selector.name}`;
}

function imageSelectorKey(selector: ImageSelector): string {
  if ('digest' in selector) return `digest:${selector.digest}`;
  if ('reference' in selector) return `reference:${selector.reference}`;
  return 'all';
}

function imageSelectorLabel(selector: ImageSelector): string {
  if ('digest' in selector) return selector.digest;
  if ('reference' in selector) return selector.reference;
  return 'All images';
}

function imageGrantCount(grant: ImageGrant): number {
  return (
    grant.read.length +
    grant.use.length +
    grant.pull.length +
    grant.remove.length +
    Number(grant.prune_all_unused)
  );
}

export function acquisitionLabel(acquisition: ExtensionAcquisitionStatus): string {
  const progress = acquisition.progress;
  if (!progress) {
    const labels: Record<string, string> = {
      queued: 'Waiting for an acquisition worker…',
      inspecting: 'Checking whether the image is available for this workspace architecture…',
      'reading-manifest': 'Reading and validating the extension manifest…',
      ready: 'Manifest validated. Review requested access before installing.',
      committing: 'Saving the reviewed extension and its granted access…',
      installed: 'Extension installed.',
      updated: 'Extension updated.',
      failed: 'Inspection failed. The reference and details are retained for retry.',
      cancelled: 'Inspection cancelled. No extension was installed.',
    };
    return labels[acquisition.state] ?? 'Inspecting image…';
  }
  const amount =
    progress.current === null
      ? ''
      : progress.total === null
        ? ` · ${progress.current} bytes`
        : ` · ${progress.current}/${progress.total} bytes (${Math.min(
            100,
            Math.round((progress.current / Math.max(1, progress.total)) * 100),
          )}%)`;
  return `${progress.status}${progress.id ? ` · ${progress.id}` : ''}${amount}`.slice(0, 500);
}

export function acquisitionCancellationRecovery(state: string): string {
  if (state === 'ready') {
    return 'Inspection completed before cancellation. Review this candidate or cancel the review; nothing has been installed.';
  }
  if (state === 'committing') {
    return 'The reviewed extension started saving before cancellation. Wait for its final state before acting again.';
  }
  return 'Acquisition advanced before cancellation. Review its current phase and cancel again if needed.';
}

export function acquisitionCancellationUnverified(detail: string): string {
  return `Cancellation was accepted, but its final state could not be verified. Return to the catalogue before trying again. ${detail}`;
}

export function acquisitionProgressFraction(
  acquisition: ExtensionAcquisitionStatus,
): number | undefined {
  const current = acquisition.progress?.current;
  const total = acquisition.progress?.total;
  if (
    current === null ||
    current === undefined ||
    total === null ||
    total === undefined ||
    total <= 0
  )
    return undefined;
  return Math.min(1, Math.max(0, current / total));
}

export function acquisitionFailure(
  detail: string,
  catalogueEntry: ExtensionCatalogueEntry | null = null,
): string {
  const normalized = detail.replaceAll('\\n', ' ').replaceAll(/\s+/g, ' ').trim();
  const registryMessage = /"message"\s*:\s*"([^"]+)"/.exec(normalized)?.[1];
  const architecture = /linux\/([A-Za-z0-9_-]+).*requires linux\/([A-Za-z0-9_-]+)/i.exec(
    normalized,
  );
  if (/unauthorized|denied|authentication required|insufficient_scope/i.test(normalized)) {
    if (isVerifiedFirstPartyCatalogueEntry(catalogueEntry)) {
      return 'This verified Husklet release image is unavailable from its public registry. Check your connection and retry. If it remains unavailable, update Husklet to a release with a matching published extension image.';
    }
    return 'Registry access denied. Sign in with credentials that can read this image, or verify that the image is public.';
  }
  if (registryMessage) {
    return `The registry could not provide this image: ${registryMessage}. Verify the image name, version, and visibility.`.slice(
      0,
      300,
    );
  }
  if (architecture) {
    return `Architecture mismatch. This image is linux/${architecture[1]}, but the workspace is linux/${architecture[2]}. Choose an image published for this workspace architecture.`;
  }
  if (/manifest/i.test(normalized)) {
    return "Extension manifest could not be validated. Check the image's Husklet manifest label and protocol version.";
  }
  if (/workspace (execution domain|resources) (failed|unavailable)|Engine\(/i.test(normalized)) {
    return 'Workspace image service is unavailable. Reopen the workspace, then retry inspection.';
  }
  return 'The image could not be inspected. Verify its registry, name, version, and visibility, then retry.';
}

export function isAcquisitionAuthenticationFailure(detail: string | null | undefined): boolean {
  return /unauthorized|denied|authentication required|insufficient_scope/i.test(detail ?? '');
}

export function acquisitionTechnicalDetail(detail: string): string {
  const normalized = detail.replaceAll('\\n', '\n').trim();
  if (normalized.length <= 4_096) return normalized;
  return `${normalized.slice(0, 4_096)}\n… technical detail truncated`;
}

function lifecycleResult(action: LifecycleAction): string {
  return action === 'enable'
    ? 'enabled'
    : action === 'disable'
      ? 'disabled'
      : action === 'retry'
        ? 'recovered'
        : 'removed';
}

export function extensionRemovalQuestion(name: string): string {
  return `Remove ${name}? Its private data and grants will be deleted. Created containers, images, volumes, and networks remain.`;
}

export function lifecycleStateObserved(
  action: LifecycleAction,
  expected: ExtensionSummary,
  current: ExtensionSummary | undefined,
): boolean {
  if (action === 'remove') {
    return !current;
  }
  if (!current || current.image_digest !== expected.image_digest) return false;
  if (action === 'disable') return current.enabled !== true;
  if (action === 'enable') return current.enabled === true && !current.status.startsWith('fault:');
  return current.enabled === true && current.status === 'duty';
}

function lifecyclePending(action: LifecycleAction): string {
  return action === 'enable'
    ? 'Enabling'
    : action === 'disable'
      ? 'Disabling'
      : action === 'retry'
        ? 'Retrying'
        : 'Removing';
}

function extensionState(extension: ExtensionSummary): string {
  if (!extension.enabled) return 'disabled';
  if (extension.status.startsWith('fault:')) return 'faulted';
  return extension.status === 'duty' ? 'enabled' : extension.status;
}

function ExtensionFault({ extension }: { extension: ExtensionSummary }) {
  if (!extension.enabled || !extension.status.startsWith('fault:')) return null;
  const detail =
    extension.status.slice('fault:'.length).trim() || 'The extension stopped unexpectedly.';
  return <RecoveryState operation="Extension" error={detail} />;
}

function LifecycleFeedback({
  extensionName,
  pending,
  failure,
}: {
  extensionName: string;
  pending: LifecycleState | null;
  failure: (LifecycleState & { detail: string }) | null;
}) {
  if (pending?.name === extensionName)
    return (
      <InlineMessage
        label={`${lifecyclePending(pending.action)} ${extensionName}…`}
        tone="neutral"
      />
    );
  if (failure?.name === extensionName)
    return (
      <RecoveryState operation={`${capitalize(failure.action)} extension`} error={failure.detail} />
    );
  return null;
}

function capitalize(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function newerVersion(candidate: string, installed?: string): boolean {
  if (!installed) return true;
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match ? match.slice(1).map(Number) : null;
  };
  const next = parse(candidate);
  const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

export function capabilityLabel(capability: ExtensionCapability): string {
  const known: Record<ExtensionCapability, string> = {
    'workspaces:read': 'View workspace settings',
    'workspaces:configure': 'Modify workspace settings',
    'workspaces:create': 'Create workspaces',
    'workspaces:lifecycle': 'Start, stop, and restart workspaces',
    'workspaces:remove': 'Permanently delete workspaces',
    'workspaces:events': 'Observe workspace lifecycle',
    'workspace-environment:read': 'Read selected workspace environment values',
    'workspace-environment:write': 'Change selected workspace environment values',
    'extensions:read': 'View installed extensions',
    'extensions:acquire': 'Inspect and download extension images',
    'extensions:control': 'Enable, disable, and retry extensions',
    'extensions:install': 'Install new extensions',
    'extensions:update': 'Replace installed extensions',
    'extensions:remove': 'Remove extensions',
    'containers:read': 'View containers and processes',
    'containers:create': 'Create containers from consented images',
    'containers:execute': 'Run and control detached processes in containers',
    'containers:input': 'Write to detached process input',
    'containers:lifecycle': 'Start, stop, pause, restart, rename, and signal containers',
    'containers:remove': 'Permanently remove containers',
    'containers:attach': 'Run commands inside containers',
    'images:read': 'View images',
    'images:pull': 'Pull images',
    'images:remove': 'Remove images',
    'images:prune': 'Prune every unused image',
    'volumes:read': 'View volumes',
    'volumes:write': 'Create and remove volumes',
    'networks:read': 'View networks',
    'networks:create': 'Create networks',
    'networks:remove': 'Permanently remove networks',
    'networks:connect': 'Attach containers to networks',
    'networks:disconnect': 'Detach containers from networks',
    'networks:publish': 'Publish container ports on the host',
    'terminals:read': 'View terminal tabs and panes',
    'terminals:input': 'Type into terminal panes',
    'terminals:focus': 'Move keyboard focus between terminal panes',
    'terminals:layout-control': 'Create and rearrange terminal panes',
    'terminals:process-control': 'Replace processes in terminal panes',
    'terminals:output': 'Read terminal text',
    'panes:observe': 'Observe pane interaction',
    'panes:semantic-read': 'Read structured pane interfaces',
    'panes:semantic-control': 'Operate structured pane interfaces',
    'interface:render': 'Render this extension interface',
    'filesystem:read': 'Read selected workspace files',
    'filesystem:write': 'Change selected workspace files',
    'state:read': 'Read this extension’s private state',
    'state:write': 'Change this extension’s private state',
    'preferences:read': 'Read this extension’s interface preferences',
    'preferences:write': 'Change this extension’s interface preferences',
    'credentials:read': 'Read selected extension credentials',
    'credentials:expose-to-execution': 'Expose selected credentials to launched processes',
    'credentials:use': 'Use selected credentials through trusted host services',
    'credentials:write': 'Change selected extension credentials',
    'postgres:read': 'Inspect PostgreSQL connections and query results',
    'postgres:write': 'Run caller-provided SQL against PostgreSQL',
    'notifications:publish': 'Show workspace notifications',
  };
  return known[capability];
}

function compactDigest(digest: string): string {
  return digest.length > 32 ? `${digest.slice(0, 19)}…${digest.slice(-8)}` : digest;
}

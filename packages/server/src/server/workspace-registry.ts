import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";
import { WorkspacePinGroupSchema, type WorkspacePinGroup } from "@getpaseo/protocol/messages";

import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  generateProjectId,
  generateWorkspacePinGroupId,
  type PersistedProjectKind,
  type PersistedWorkspaceKind,
} from "./workspace-registry-model.js";

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // COMPAT(projectKey): added in v0.2.4 on 2026-07-28; remove optional after 2027-01-28.
  projectKey: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Identifies the project's stored custom icon; null means automatic.
  customIconRevision: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Exact checkout/worktree root backing cwd. This differs from cwd when the
  // selected project is a subdirectory inside a repository. Persist it so
  // archive and recovery do not need the directory to still exist in order to
  // recover placement.
  worktreeRoot: z.string().nullable().default(null),
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  isPaseoOwnedWorktree: z.boolean().default(false),
  mainRepoRoot: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  // COMPAT(autoArchivedChangeRequestUrl): added in v0.2.6, remove optional parsing after 2027-01-31.
  // Records the merged change request whose automatic archive was consumed.
  autoArchivedChangeRequestUrl: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  pinGroupId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  pinGroupAssignedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  labels: z.array(z.string()).optional(),
});

const WorkspaceRegistryFileSchema = z.union([
  z.array(PersistedWorkspaceRecordSchema),
  z.object({
    workspaces: z.array(PersistedWorkspaceRecordSchema),
    pinGroups: z.array(WorkspacePinGroupSchema),
  }),
]);

const WorkspacePinGroupMembershipSchema = z.object({
  groupId: z.string(),
  assignedAt: z.string(),
});

const WorkspacePinGroupsFileSchema = z.object({
  groups: z.array(WorkspacePinGroupSchema),
  memberships: z.record(z.string(), WorkspacePinGroupMembershipSchema),
});

const RawFileBeforeImageSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), contents: z.string() }),
]);

const WorkspacePinGroupsTransactionSchema = z.object({
  phase: z.enum(["prepared", "committed"]),
  beforeWorkspaces: RawFileBeforeImageSchema,
  afterWorkspaces: z.array(PersistedWorkspaceRecordSchema),
  beforePinGroups: RawFileBeforeImageSchema,
  afterPinGroups: WorkspacePinGroupsFileSchema,
});

export const DEFAULT_WORKSPACE_PIN_GROUP_ID = "default";
export const DEFAULT_WORKSPACE_PIN_GROUP_NAME = "Pinned";

export type WorkspacePinGroupErrorCode =
  | "invalid_name"
  | "default_group_immutable"
  | "group_not_found";

export class WorkspacePinGroupError extends Error {
  constructor(
    public readonly code: WorkspacePinGroupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePinGroupError";
  }
}

function normalizePinGroupName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new WorkspacePinGroupError("invalid_name", "Pin group name must not be empty");
  }
  return normalized;
}

// COMPAT(workspacePinGroups): added in v0.7.0, remove pinnedAt migration/projection after 2027-03-01.
function normalizeWorkspacePinMembership(
  workspace: PersistedWorkspaceRecord,
  pinGroups: ReadonlyMap<string, WorkspacePinGroup>,
): PersistedWorkspaceRecord {
  let pinGroupId = workspace.pinGroupId;
  if (!pinGroupId && workspace.pinnedAt) pinGroupId = DEFAULT_WORKSPACE_PIN_GROUP_ID;
  if (pinGroupId && !pinGroups.has(pinGroupId)) pinGroupId = null;

  const pinGroupAssignedAt = pinGroupId
    ? (workspace.pinGroupAssignedAt ?? workspace.pinnedAt ?? workspace.updatedAt)
    : null;
  // COMPAT(workspacePinGroups): added in v0.7.0, remove pinnedAt projection after 2027-03-01.
  const pinnedAt = pinGroupId === DEFAULT_WORKSPACE_PIN_GROUP_ID ? pinGroupAssignedAt : null;
  return { ...workspace, pinGroupId, pinGroupAssignedAt, pinnedAt };
}

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;

export type PersistedWorkspacePinGroupMembership = z.infer<
  typeof WorkspacePinGroupMembershipSchema
>;

export type PersistedWorkspacePinGroupsFile = z.infer<typeof WorkspacePinGroupsFileSchema>;

type RawFileBeforeImage = z.infer<typeof RawFileBeforeImageSchema>;
type PersistedWorkspacePinGroupsTransaction = z.infer<typeof WorkspacePinGroupsTransactionSchema>;

function pinGroupTransactionDataEqual(
  left: PersistedWorkspacePinGroupsTransaction,
  right: PersistedWorkspacePinGroupsTransaction,
): boolean {
  return (
    JSON.stringify({ ...left, phase: "prepared" }) ===
    JSON.stringify({ ...right, phase: "prepared" })
  );
}

interface WorkspaceRegistryPersistenceState {
  pinGroups: Map<string, WorkspacePinGroup>;
  persistedPinGroupsFile: PersistedWorkspacePinGroupsFile | null;
  legacyEnvelope: {
    pinGroups: WorkspacePinGroup[];
  } | null;
  workspaceFileWasEnvelope: boolean;
}

export type WorkspaceMutation =
  | {
      kind: "upsert" | "archive" | "remove";
      workspaceId: string;
      workspace: PersistedWorkspaceRecord | null;
      expectsInitialAgent?: boolean;
    }
  | {
      kind: "pin_groups";
      pinGroups: WorkspacePinGroup[];
    };

export interface WorkspaceMutationContext {
  expectsInitialAgent?: boolean;
}

export interface WorkspaceArchiveContext {
  autoArchivedChangeRequestUrl?: string;
}

export interface ProjectMutation {
  kind: "upsert" | "archive" | "remove";
  projectId: string;
  project: PersistedProjectRecord | null;
}

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  update(
    projectId: string,
    updater: (record: PersistedProjectRecord) => PersistedProjectRecord,
  ): Promise<PersistedProjectRecord | null>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
  /** Central lifecycle seam for daemon-global project observers. */
  subscribeToMutations?(listener: (mutation: ProjectMutation) => void | Promise<void>): () => void;
}

export interface WorkspaceRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord, context?: WorkspaceMutationContext): Promise<void>;
  archive(
    workspaceId: string,
    archivedAt: string,
    context?: WorkspaceArchiveContext,
  ): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  listPinGroups(): Promise<WorkspacePinGroup[]>;
  createPinGroup(name: string): Promise<WorkspacePinGroup>;
  renamePinGroup(groupId: string, name: string): Promise<WorkspacePinGroup>;
  deletePinGroup(groupId: string): Promise<string[]>;
  setWorkspacePinGroup(input: {
    workspaceId: string;
    groupId: string | null;
    updatedAt: string;
  }): Promise<PersistedWorkspaceRecord | null>;
  /** Central lifecycle seam for daemon-global workspace observers. */
  subscribeToMutations?(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  protected readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationsBlockedUntilRestart = false;
  private readonly writeRecords: (filePath: string, records: readonly TRecord[]) => Promise<void>;
  private readonly parseRecords: (value: unknown) => readonly TRecord[];

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
    writeRecords?: (filePath: string, records: readonly TRecord[]) => Promise<void>;
    parseRecords?: (value: unknown) => readonly TRecord[];
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
    this.writeRecords = options.writeRecords ?? writeJsonFileAtomic;
    this.parseRecords = options.parseRecords ?? ((value) => z.array(this.schema).parse(value));
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    const parsed = this.schema.parse(record);
    await this.mutateCache((records) => {
      records.set(this.getId(parsed), parsed);
      return undefined;
    });
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse(updater(existing));
      records.set(id, next);
      return next;
    });
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.archiveIfPresent(id, archivedAt);
  }

  protected async archiveIfPresent(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }

  protected async archiveIfActive(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing || existing.archivedAt) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.removeIfPresent(id);
  }

  protected async removeIfPresent(id: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      records.delete(id);
      return existing;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = this.parseRecords(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      throw error;
    }
    this.loaded = true;
  }

  protected async mutateMany(
    updater: (records: ReadonlyMap<string, TRecord>) => readonly TRecord[],
  ): Promise<TRecord[]> {
    return this.mutateCache((records) => {
      const changed = updater(records);
      if (changed.length === 0) return [];
      const parsed = changed.map((record) => this.schema.parse(record));
      for (const record of parsed) records.set(this.getId(record), record);
      return parsed;
    });
  }

  protected async hydrateCache(records: readonly TRecord[]): Promise<void> {
    await this.load();
    this.cache.clear();
    for (const record of records) {
      const parsed = this.schema.parse(record);
      this.cache.set(this.getId(parsed), parsed);
    }
  }

  protected async mutateCache<TResult>(
    updater: (records: Map<string, TRecord>) => TResult,
    hooks?: {
      forcePersist?: (result: TResult) => boolean;
      beforeWrite?: (records: readonly TRecord[]) => Promise<void>;
      afterWrite?: () => Promise<void>;
      afterCommit?: () => void;
      forceRecordWrite?: (result: TResult) => boolean;
      writeRecords?: (records: readonly TRecord[]) => Promise<void>;
    },
  ): Promise<TResult> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      if (this.mutationsBlockedUntilRestart) {
        throw new Error("Workspace registry mutations are blocked until daemon restart");
      }
      const staged = new Map(this.cache);
      const result = updater(staged);
      const recordsChanged = !mapsEqual(this.cache, staged);
      const forcePersist = hooks?.forcePersist?.(result) === true;
      const forceRecordWrite = hooks?.forceRecordWrite?.(result) === true;
      if (!recordsChanged && !forcePersist && !forceRecordWrite) return result;
      const records = Array.from(staged.values());
      await hooks?.beforeWrite?.(records);
      if (recordsChanged || forceRecordWrite) {
        await this.persistRecords(records, hooks?.writeRecords);
      }
      await hooks?.afterWrite?.();
      if (recordsChanged) {
        this.cache.clear();
        for (const [id, record] of staged) this.cache.set(id, record);
      }
      hooks?.afterCommit?.();
      return result;
    } finally {
      release();
    }
  }

  protected freezeMutationsUntilRestart(): void {
    this.mutationsBlockedUntilRestart = true;
  }

  private async persistRecords(
    records: readonly TRecord[],
    writer?: (records: readonly TRecord[]) => Promise<void>,
  ): Promise<void> {
    if (writer) {
      await writer(records);
      return;
    }
    await this.writeRecords(this.filePath, records);
  }
}

function mapsEqual<TKey, TValue>(left: Map<TKey, TValue>, right: Map<TKey, TValue>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly projectIdFactory: () => string;
  private readonly mutationListeners = new Set<
    (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>
  >();

  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      projectIdFactory?: () => string;
      writeRecords?: (
        filePath: string,
        records: readonly PersistedProjectRecord[],
      ) => Promise<void>;
    },
  ) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
      writeRecords: options?.writeRecords,
    });
    this.projectIdFactory = options?.projectIdFactory ?? generateProjectId;
  }

  async getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord> {
    const previous = this.allocationQueue;
    let release!: () => void;
    this.allocationQueue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const active = (await this.list())
        .filter(
          (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, input.rootPath),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.projectId.localeCompare(right.projectId),
        )[0];
      if (active) {
        if (active.kind === input.kind && active.projectKey === (input.projectKey ?? null))
          return active;
        const refreshed = {
          ...active,
          kind: input.kind,
          projectKey: input.projectKey ?? null,
          updatedAt: input.timestamp,
        };
        await this.upsert(refreshed);
        return refreshed;
      }

      for (;;) {
        const projectId = this.projectIdFactory();
        if (await this.get(projectId)) continue;
        const record = createPersistedProjectRecord({
          projectId,
          rootPath: input.rootPath,
          kind: input.kind,
          displayName: input.displayName,
          projectKey: input.projectKey ?? null,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
        });
        await this.upsert(record);
        return record;
      }
    } finally {
      release();
    }
  }

  subscribeToMutations(
    listener: (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async upsert(record: PersistedProjectRecord): Promise<void> {
    await super.upsert(record);
    await this.notifyMutation({ kind: "upsert", projectId: record.projectId, project: record });
  }

  override async update(
    projectId: string,
    updater: (record: PersistedProjectRecord) => PersistedProjectRecord,
  ): Promise<PersistedProjectRecord | null> {
    const project = await super.update(projectId, updater);
    if (!project) return null;
    await this.notifyMutation({ kind: "upsert", projectId, project });
    return project;
  }

  override async archive(projectId: string, archivedAt: string): Promise<void> {
    const project = await this.archiveIfActive(projectId, archivedAt);
    if (!project) return;
    await this.notifyMutation({ kind: "archive", projectId, project });
  }

  override async remove(projectId: string): Promise<void> {
    const project = await this.removeIfPresent(projectId);
    if (!project) return;
    await this.notifyMutation({ kind: "remove", projectId, project: null });
  }

  private async notifyMutation(mutation: {
    kind: "upsert" | "archive" | "remove";
    projectId: string;
    project: PersistedProjectRecord | null;
  }): Promise<void> {
    await Promise.all([...this.mutationListeners].map((listener) => listener(mutation)));
  }
}

function resolvePinGroupsFilePath(workspacesFilePath: string): string {
  const parsed = path.parse(workspacesFilePath);
  const filename =
    parsed.base === "workspaces.json"
      ? "workspace-pin-groups.json"
      : `${parsed.name}.pin-groups${parsed.ext || ".json"}`;
  return path.join(parsed.dir, filename);
}

function resolvePinGroupsTransactionFilePath(pinGroupsFilePath: string): string {
  const parsed = path.parse(pinGroupsFilePath);
  return path.join(parsed.dir, `${parsed.name}.transaction${parsed.ext || ".json"}`);
}

function sortPinGroups(groups: Iterable<WorkspacePinGroup>): WorkspacePinGroup[] {
  return Array.from(groups).sort((left, right) => {
    if (left.id === DEFAULT_WORKSPACE_PIN_GROUP_ID) return -1;
    if (right.id === DEFAULT_WORKSPACE_PIN_GROUP_ID) return 1;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

function buildInitialPinGroups(input: {
  storedPinGroups: PersistedWorkspacePinGroupsFile | null;
  legacyEnvelope: WorkspaceRegistryPersistenceState["legacyEnvelope"];
  workspaces: readonly PersistedWorkspaceRecord[];
  now: () => string;
}): Map<string, WorkspacePinGroup> {
  const storedGroups = input.storedPinGroups?.groups ?? input.legacyEnvelope?.pinGroups ?? [];
  const pinGroups = new Map(storedGroups.map((group) => [group.id, group]));
  const defaultCreatedAt =
    input.workspaces
      .map((workspace) => workspace.pinnedAt)
      .filter((pinnedAt): pinnedAt is string => pinnedAt !== null)
      .sort()[0] ?? input.now();
  const storedDefault = pinGroups.get(DEFAULT_WORKSPACE_PIN_GROUP_ID);
  pinGroups.set(DEFAULT_WORKSPACE_PIN_GROUP_ID, {
    id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
    name: DEFAULT_WORKSPACE_PIN_GROUP_NAME,
    createdAt: storedDefault?.createdAt ?? defaultCreatedAt,
  });
  return pinGroups;
}

function buildInitialMemberships(input: {
  storedPinGroups: PersistedWorkspacePinGroupsFile | null;
  workspaces: readonly PersistedWorkspaceRecord[];
  pinGroups: ReadonlyMap<string, WorkspacePinGroup>;
}): Record<string, PersistedWorkspacePinGroupMembership> {
  const workspaceIds = new Set(input.workspaces.map((workspace) => workspace.workspaceId));
  const memberships: Record<string, PersistedWorkspacePinGroupMembership> = {};
  for (const [workspaceId, membership] of Object.entries(
    input.storedPinGroups?.memberships ?? {},
  )) {
    if (!workspaceIds.has(workspaceId) || !input.pinGroups.has(membership.groupId)) continue;
    memberships[workspaceId] = membership;
  }
  for (const workspace of input.workspaces) {
    if (memberships[workspace.workspaceId]) continue;
    const groupId =
      workspace.pinGroupId ?? (workspace.pinnedAt ? DEFAULT_WORKSPACE_PIN_GROUP_ID : null);
    if (!groupId || !input.pinGroups.has(groupId)) continue;
    memberships[workspace.workspaceId] = {
      groupId,
      assignedAt: workspace.pinGroupAssignedAt ?? workspace.pinnedAt ?? workspace.updatedAt,
    };
  }
  return memberships;
}

function workspacesWithMemberships(
  workspaces: readonly PersistedWorkspaceRecord[],
  memberships: Readonly<Record<string, PersistedWorkspacePinGroupMembership>>,
): PersistedWorkspaceRecord[] {
  return workspaces.map((workspace) => {
    const membership = memberships[workspace.workspaceId];
    return {
      ...workspace,
      pinGroupId: membership?.groupId ?? null,
      pinGroupAssignedAt: membership?.assignedAt ?? null,
    };
  });
}

function buildPinGroupsFile(
  workspaces: readonly PersistedWorkspaceRecord[],
  pinGroups: ReadonlyMap<string, WorkspacePinGroup>,
): PersistedWorkspacePinGroupsFile {
  const memberships = Object.fromEntries(
    workspaces
      .flatMap((workspace) => {
        if (!workspace.pinGroupId || !pinGroups.has(workspace.pinGroupId)) return [];
        return [
          [
            workspace.workspaceId,
            {
              groupId: workspace.pinGroupId,
              assignedAt: workspace.pinGroupAssignedAt ?? workspace.pinnedAt ?? workspace.updatedAt,
            },
          ] as const,
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return WorkspacePinGroupsFileSchema.parse({
    groups: sortPinGroups(pinGroups.values()),
    memberships,
  });
}

function pinGroupFilesEqual(
  left: PersistedWorkspacePinGroupsFile | null,
  right: PersistedWorkspacePinGroupsFile,
): boolean {
  if (!left) return false;
  const canonicalLeft = WorkspacePinGroupsFileSchema.parse({
    groups: sortPinGroups(left.groups),
    memberships: Object.fromEntries(
      Object.entries(left.memberships).sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
    ),
  });
  return JSON.stringify(canonicalLeft) === JSON.stringify(right);
}

function toLegacyWorkspaceRecord(workspace: PersistedWorkspaceRecord): PersistedWorkspaceRecord {
  const { pinGroupId: _pinGroupId, pinGroupAssignedAt: _pinGroupAssignedAt, ...legacy } = workspace;
  return legacy as PersistedWorkspaceRecord;
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly registryFilePath: string;
  private readonly pinGroupsFilePath: string;
  private readonly pinGroupsTransactionFilePath: string;
  private readonly pinGroupIdFactory: () => string;
  private readonly now: () => string;
  private readonly persistenceState: WorkspaceRegistryPersistenceState;
  private readonly writeWorkspaceRecords: (
    filePath: string,
    records: readonly PersistedWorkspaceRecord[],
  ) => Promise<void>;
  private readonly writePinGroupsFile: (
    filePath: string,
    state: PersistedWorkspacePinGroupsFile,
  ) => Promise<void>;
  private readonly writePinGroupsTransaction: (
    filePath: string,
    transaction: PersistedWorkspacePinGroupsTransaction,
  ) => Promise<void>;
  private readonly writeRawFile: (filePath: string, contents: string) => Promise<void>;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private readonly mutationListeners = new Set<
    (mutation: WorkspaceMutation) => void | Promise<void>
  >();

  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      writeRecords?: (
        filePath: string,
        records: readonly PersistedWorkspaceRecord[],
      ) => Promise<void>;
      pinGroupsFilePath?: string;
      pinGroupsTransactionFilePath?: string;
      writePinGroupsFile?: (
        filePath: string,
        state: PersistedWorkspacePinGroupsFile,
      ) => Promise<void>;
      writePinGroupsTransaction?: (
        filePath: string,
        transaction: PersistedWorkspacePinGroupsTransaction,
      ) => Promise<void>;
      writeRawFile?: (filePath: string, contents: string) => Promise<void>;
      pinGroupIdFactory?: () => string;
      now?: () => string;
    },
  ) {
    const now = options?.now ?? (() => new Date().toISOString());
    const persistenceState: WorkspaceRegistryPersistenceState = {
      pinGroups: new Map(),
      persistedPinGroupsFile: null,
      legacyEnvelope: null,
      workspaceFileWasEnvelope: false,
    };
    let persistFiles!: (
      records: readonly PersistedWorkspaceRecord[],
      pinGroups: ReadonlyMap<string, WorkspacePinGroup>,
    ) => Promise<void>;
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
      parseRecords: (value) => {
        const parsed = WorkspaceRegistryFileSchema.parse(value);
        if (Array.isArray(parsed)) return parsed;
        // COMPAT(pinGroups): the v0.7.0 pre-release wrote this envelope; remove after 2027-03-01.
        persistenceState.workspaceFileWasEnvelope = true;
        persistenceState.legacyEnvelope = { pinGroups: parsed.pinGroups };
        return parsed.workspaces;
      },
      writeRecords: async (_targetPath, records) =>
        persistFiles(records, persistenceState.pinGroups),
    });
    this.registryFilePath = filePath;
    this.pinGroupsFilePath = options?.pinGroupsFilePath ?? resolvePinGroupsFilePath(filePath);
    this.pinGroupsTransactionFilePath =
      options?.pinGroupsTransactionFilePath ??
      resolvePinGroupsTransactionFilePath(this.pinGroupsFilePath);
    this.pinGroupIdFactory = options?.pinGroupIdFactory ?? generateWorkspacePinGroupId;
    this.now = now;
    this.persistenceState = persistenceState;
    this.writeWorkspaceRecords = options?.writeRecords ?? writeJsonFileAtomic;
    this.writePinGroupsFile = options?.writePinGroupsFile ?? writeJsonFileAtomic;
    this.writePinGroupsTransaction = options?.writePinGroupsTransaction ?? writeJsonFileAtomic;
    this.writeRawFile = options?.writeRawFile ?? writeFileAtomic;
    persistFiles = (records, pinGroups) => this.persistFiles(records, pinGroups);
  }

  override async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.loadPinGroupState().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  override async list(): Promise<PersistedWorkspaceRecord[]> {
    await this.initialize();
    return super.list();
  }

  override async get(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    await this.initialize();
    return super.get(workspaceId);
  }

  async listPinGroups(): Promise<WorkspacePinGroup[]> {
    await this.initialize();
    return sortPinGroups(this.persistenceState.pinGroups.values());
  }

  async createPinGroup(name: string): Promise<WorkspacePinGroup> {
    const normalizedName = normalizePinGroupName(name);
    return this.commitPinGroupMutation((_, pinGroups) => {
      let id = this.pinGroupIdFactory();
      while (pinGroups.has(id)) id = this.pinGroupIdFactory();
      const group = WorkspacePinGroupSchema.parse({
        id,
        name: normalizedName,
        createdAt: this.now(),
      });
      pinGroups.set(id, group);
      return { value: group, changedWorkspaces: [] };
    });
  }

  async renamePinGroup(groupId: string, name: string): Promise<WorkspacePinGroup> {
    if (groupId === DEFAULT_WORKSPACE_PIN_GROUP_ID) {
      throw new WorkspacePinGroupError(
        "default_group_immutable",
        "The default pin group cannot be renamed",
      );
    }
    const normalizedName = normalizePinGroupName(name);
    return this.commitPinGroupMutation((_, pinGroups) => {
      const existing = pinGroups.get(groupId);
      if (!existing) {
        throw new WorkspacePinGroupError("group_not_found", "Pin group not found");
      }
      const group = { ...existing, name: normalizedName };
      pinGroups.set(groupId, group);
      return { value: group, changedWorkspaces: [] };
    });
  }

  async deletePinGroup(groupId: string): Promise<string[]> {
    if (groupId === DEFAULT_WORKSPACE_PIN_GROUP_ID) {
      throw new WorkspacePinGroupError(
        "default_group_immutable",
        "The default pin group cannot be deleted",
      );
    }
    const updatedAt = this.now();
    return this.commitPinGroupMutation((workspaces, pinGroups) => {
      if (!pinGroups.delete(groupId)) {
        throw new WorkspacePinGroupError("group_not_found", "Pin group not found");
      }
      const changedWorkspaces: PersistedWorkspaceRecord[] = [];
      for (const workspace of workspaces.values()) {
        if (workspace.pinGroupId !== groupId) continue;
        const updated = {
          ...workspace,
          pinGroupId: null,
          pinGroupAssignedAt: null,
          pinnedAt: null,
          updatedAt,
        };
        workspaces.set(workspace.workspaceId, updated);
        changedWorkspaces.push(updated);
      }
      return {
        value: changedWorkspaces.map((workspace) => workspace.workspaceId),
        changedWorkspaces,
      };
    });
  }

  async setWorkspacePinGroup(input: {
    workspaceId: string;
    groupId: string | null;
    updatedAt: string;
  }): Promise<PersistedWorkspaceRecord | null> {
    await this.initialize();
    const workspace = await this.mutateCache((workspaces) => {
      if (input.groupId && !this.persistenceState.pinGroups.has(input.groupId)) {
        throw new WorkspacePinGroupError("group_not_found", "Pin group not found");
      }
      const existing = workspaces.get(input.workspaceId);
      if (!existing) return null;
      // COMPAT(workspacePinGroups): added in v0.7.0, remove pinnedAt projection after 2027-03-01.
      const pinnedAt = input.groupId === DEFAULT_WORKSPACE_PIN_GROUP_ID ? input.updatedAt : null;
      const updated = PersistedWorkspaceRecordSchema.parse({
        ...existing,
        pinGroupId: input.groupId,
        pinGroupAssignedAt: input.groupId ? input.updatedAt : null,
        pinnedAt,
        updatedAt: input.updatedAt,
      });
      workspaces.set(input.workspaceId, updated);
      return updated;
    });
    if (workspace) {
      await this.notifyMutation({
        kind: "upsert",
        workspaceId: workspace.workspaceId,
        workspace,
      });
    }
    return workspace;
  }

  private async commitPinGroupMutation<TResult>(
    stage: (
      workspaces: Map<string, PersistedWorkspaceRecord>,
      pinGroups: Map<string, WorkspacePinGroup>,
    ) => { value: TResult; changedWorkspaces: PersistedWorkspaceRecord[] },
  ): Promise<TResult> {
    await this.initialize();
    let nextPinGroups = this.persistenceState.pinGroups;
    let changedWorkspaces: PersistedWorkspaceRecord[] = [];
    const value = await this.mutateCache(
      (workspaces) => {
        const stagedPinGroups = new Map(this.persistenceState.pinGroups);
        const staged = stage(workspaces, stagedPinGroups);
        nextPinGroups = stagedPinGroups;
        changedWorkspaces = staged.changedWorkspaces.map((workspace) =>
          PersistedWorkspaceRecordSchema.parse(workspace),
        );
        return staged.value;
      },
      {
        forceRecordWrite: () => true,
        writeRecords: (workspaces) => this.persistFiles(workspaces, nextPinGroups),
      },
    );
    await this.notifyMutation({
      kind: "pin_groups",
      pinGroups: sortPinGroups(nextPinGroups.values()),
    });
    await Promise.all(
      changedWorkspaces.map((workspace) =>
        this.notifyMutation({ kind: "upsert", workspaceId: workspace.workspaceId, workspace }),
      ),
    );
    return value;
  }

  private async loadPinGroupState(): Promise<void> {
    await this.recoverPinGroupTransaction();
    await super.initialize();
    const workspaces = await super.list();
    const storedPinGroups = await this.readPinGroupsFile();
    const pinGroups = buildInitialPinGroups({
      storedPinGroups,
      legacyEnvelope: this.persistenceState.legacyEnvelope,
      workspaces,
      now: this.now,
    });
    this.persistenceState.pinGroups = pinGroups;
    this.persistenceState.persistedPinGroupsFile = storedPinGroups;

    const memberships = buildInitialMemberships({
      storedPinGroups,
      workspaces,
      pinGroups,
    });
    const normalizedWorkspaces = workspacesWithMemberships(workspaces, memberships).map(
      (workspace) => normalizeWorkspacePinMembership(workspace, pinGroups),
    );
    const workspaceProjectionChanged = workspaces.some(
      (workspace, index) => workspace.pinnedAt !== normalizedWorkspaces[index]?.pinnedAt,
    );
    const pinGroupsFileChanged = !pinGroupFilesEqual(
      storedPinGroups,
      buildPinGroupsFile(normalizedWorkspaces, pinGroups),
    );
    const needsPersistence =
      this.persistenceState.workspaceFileWasEnvelope ||
      workspaceProjectionChanged ||
      pinGroupsFileChanged;
    if (needsPersistence) {
      await this.mutateCache(
        (records) => {
          for (const workspace of normalizedWorkspaces) {
            records.set(workspace.workspaceId, workspace);
          }
          return undefined;
        },
        { forceRecordWrite: () => true },
      );
    } else {
      await this.hydrateCache(normalizedWorkspaces);
    }
    this.persistenceState.legacyEnvelope = null;
    this.persistenceState.workspaceFileWasEnvelope = false;
    this.initialized = true;
  }

  private async readPinGroupsFile(): Promise<PersistedWorkspacePinGroupsFile | null> {
    try {
      const raw = await fs.readFile(this.pinGroupsFilePath, "utf8");
      return WorkspacePinGroupsFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.error(
        { err: error, filePath: this.pinGroupsFilePath },
        "Failed to load workspace pin groups file",
      );
      throw error;
    }
  }

  private async readPinGroupTransaction(): Promise<PersistedWorkspacePinGroupsTransaction | null> {
    try {
      const raw = await fs.readFile(this.pinGroupsTransactionFilePath, "utf8");
      return WorkspacePinGroupsTransactionSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async recoverPinGroupTransaction(): Promise<void> {
    const transaction = await this.readPinGroupTransaction();
    if (!transaction) return;
    if (transaction.phase === "prepared") {
      await this.restorePinGroupTransactionBeforeState(transaction);
      return;
    }
    await fs.rm(this.pinGroupsTransactionFilePath, { force: true }).catch(() => undefined);
  }

  private async restorePinGroupTransactionBeforeState(
    transaction: PersistedWorkspacePinGroupsTransaction,
  ): Promise<void> {
    await this.restoreRawFileBeforeImage(this.pinGroupsFilePath, transaction.beforePinGroups);
    await this.restoreRawFileBeforeImage(this.registryFilePath, transaction.beforeWorkspaces);
    await fs.rm(this.pinGroupsTransactionFilePath, { force: true });
  }

  private async readRawFileBeforeImage(filePath: string): Promise<RawFileBeforeImage> {
    try {
      return { exists: true, contents: await fs.readFile(filePath, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  }

  private async restoreRawFileBeforeImage(
    filePath: string,
    beforeImage: RawFileBeforeImage,
  ): Promise<void> {
    if (beforeImage.exists) {
      await this.writeRawFile(filePath, beforeImage.contents);
      return;
    }
    await fs.rm(filePath, { force: true });
  }

  private async persistFiles(
    records: readonly PersistedWorkspaceRecord[],
    pinGroups: ReadonlyMap<string, WorkspacePinGroup>,
  ): Promise<void> {
    const pinGroupsFile = buildPinGroupsFile(records, pinGroups);
    const sidecarChanged = !pinGroupFilesEqual(
      this.persistenceState.persistedPinGroupsFile,
      pinGroupsFile,
    );
    const workspaceFile = records.map(toLegacyWorkspaceRecord);
    if (!sidecarChanged) {
      await this.writeWorkspaceRecords(this.registryFilePath, workspaceFile);
    } else {
      const transaction = WorkspacePinGroupsTransactionSchema.parse({
        phase: "prepared",
        beforeWorkspaces: await this.readRawFileBeforeImage(this.registryFilePath),
        afterWorkspaces: workspaceFile,
        beforePinGroups: await this.readRawFileBeforeImage(this.pinGroupsFilePath),
        afterPinGroups: pinGroupsFile,
      });
      try {
        await this.writePinGroupsTransaction(this.pinGroupsTransactionFilePath, transaction);
      } catch (error) {
        await this.resolveFailedPinGroupPrepare(error, transaction);
      }
      try {
        await this.writePinGroupsFile(this.pinGroupsFilePath, pinGroupsFile);
        await this.writeWorkspaceRecords(this.registryFilePath, workspaceFile);
        await this.writePinGroupsTransaction(this.pinGroupsTransactionFilePath, {
          ...transaction,
          phase: "committed",
        });
      } catch (error) {
        await this.resolveFailedPinGroupCommit(error, transaction);
      }
      await fs.rm(this.pinGroupsTransactionFilePath, { force: true }).catch(() => undefined);
    }
    this.persistenceState.persistedPinGroupsFile = pinGroupsFile;
    this.persistenceState.pinGroups = new Map(pinGroups);
  }

  private async resolveFailedPinGroupPrepare(
    error: unknown,
    intendedTransaction: PersistedWorkspacePinGroupsTransaction,
  ): Promise<never> {
    let transaction: PersistedWorkspacePinGroupsTransaction | null;
    try {
      transaction = await this.readPinGroupTransaction();
    } catch {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    if (!transaction) throw error;
    if (
      transaction.phase !== "prepared" ||
      !pinGroupTransactionDataEqual(transaction, intendedTransaction)
    ) {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    try {
      await this.restorePinGroupTransactionBeforeState(transaction);
    } catch {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    throw error;
  }

  private async resolveFailedPinGroupCommit(
    error: unknown,
    intendedTransaction: PersistedWorkspacePinGroupsTransaction,
  ): Promise<void> {
    let transaction: PersistedWorkspacePinGroupsTransaction | null;
    try {
      transaction = await this.readPinGroupTransaction();
    } catch {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    if (!transaction || !pinGroupTransactionDataEqual(transaction, intendedTransaction)) {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    if (transaction.phase === "committed") return;
    try {
      await this.restorePinGroupTransactionBeforeState(transaction);
    } catch {
      this.freezeMutationsUntilRestart();
      throw new Error("Workspace pin-group storage outcome is uncertain", { cause: error });
    }
    throw error;
  }

  subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null> {
    await this.initialize();
    const workspace = await super.update(workspaceId, (existing) =>
      normalizeWorkspacePinMembership(updater(existing), this.persistenceState.pinGroups),
    );
    if (workspace) {
      await this.notifyMutation({ kind: "upsert", workspaceId, workspace });
    }
    return workspace;
  }

  override async upsert(
    record: PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<void> {
    await this.initialize();
    const normalized = await this.mutateCache((workspaces) => {
      const parsed = PersistedWorkspaceRecordSchema.parse(
        normalizeWorkspacePinMembership(record, this.persistenceState.pinGroups),
      );
      workspaces.set(parsed.workspaceId, parsed);
      return parsed;
    });
    await this.notifyMutation({
      kind: "upsert",
      workspaceId: normalized.workspaceId,
      workspace: normalized,
      ...(context?.expectsInitialAgent ? { expectsInitialAgent: true } : {}),
    });
  }

  override async archive(
    workspaceId: string,
    archivedAt: string,
    context?: WorkspaceArchiveContext,
  ): Promise<void> {
    await this.initialize();
    const workspace = await super.update(workspaceId, (existing) => ({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
      ...(context?.autoArchivedChangeRequestUrl
        ? { autoArchivedChangeRequestUrl: context.autoArchivedChangeRequestUrl }
        : {}),
    }));
    if (!workspace) return;
    await this.notifyMutation({ kind: "archive", workspaceId, workspace });
  }

  override async remove(workspaceId: string): Promise<void> {
    await this.initialize();
    const workspace = await this.removeIfPresent(workspaceId);
    if (!workspace) return;
    await this.notifyMutation({ kind: "remove", workspaceId, workspace: null });
  }

  async commitWorkspaceLabelMutation<TResult>(input: {
    stage: (records: ReadonlyMap<string, PersistedWorkspaceRecord>) => {
      updates: readonly PersistedWorkspaceRecord[];
      result: TResult;
      forcePersist: boolean;
    };
    beforeWorkspaceWrite: (records: readonly PersistedWorkspaceRecord[]) => Promise<void>;
    afterWorkspaceWrite: () => Promise<void>;
    afterCommit: () => void;
    publish?: boolean;
  }): Promise<TResult> {
    await this.initialize();
    let changed: PersistedWorkspaceRecord[] = [];
    const committed = await this.mutateCache(
      (records) => {
        const staged = input.stage(records);
        changed = staged.updates.map((record) => PersistedWorkspaceRecordSchema.parse(record));
        for (const record of changed) records.set(record.workspaceId, record);
        return { result: staged.result, forcePersist: staged.forcePersist };
      },
      {
        forcePersist: (output) => output.forcePersist,
        beforeWrite: input.beforeWorkspaceWrite,
        afterWrite: input.afterWorkspaceWrite,
        afterCommit: input.afterCommit,
      },
    );
    if (input.publish !== false) {
      await Promise.all(
        changed.map((workspace) =>
          this.notifyMutation({ kind: "upsert", workspaceId: workspace.workspaceId, workspace }),
        ),
      );
    }
    return committed.result;
  }

  blockAllMutationsUntilRestart(): void {
    this.freezeMutationsUntilRestart();
  }

  private async notifyMutation(mutation: WorkspaceMutation): Promise<void> {
    await Promise.all(
      [...this.mutationListeners].map(async (listener) => {
        try {
          await listener(mutation);
        } catch (error) {
          // Publication happens after the registry commit and cannot make durable state fail.
          this.logger.error({ err: error, mutation }, "Workspace mutation listener failed");
        }
      }),
    );
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  projectKey?: string | null;
  customIconRevision?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    projectKey: input.projectKey ?? null,
    customIconRevision: input.customIconRevision ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  worktreeRoot?: string | null;
  baseBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  autoArchivedChangeRequestUrl?: string | null;
  pinnedAt?: string | null;
  pinGroupId?: string | null;
  pinGroupAssignedAt?: string | null;
  labels?: string[];
}): PersistedWorkspaceRecord {
  // COMPAT(workspacePinGroups): added in v0.7.0, remove pinnedAt migration/projection after 2027-03-01.
  const pinGroupId = input.pinGroupId ?? (input.pinnedAt ? DEFAULT_WORKSPACE_PIN_GROUP_ID : null);
  const pinnedAt = pinGroupId === DEFAULT_WORKSPACE_PIN_GROUP_ID ? (input.pinnedAt ?? null) : null;
  const pinGroupAssignedAt = pinGroupId
    ? (input.pinGroupAssignedAt ?? pinnedAt ?? input.updatedAt)
    : null;
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    worktreeRoot: input.worktreeRoot ?? null,
    baseBranch: input.baseBranch ?? null,
    isPaseoOwnedWorktree: input.isPaseoOwnedWorktree ?? false,
    mainRepoRoot: input.mainRepoRoot ?? null,
    archivedAt: input.archivedAt ?? null,
    autoArchivedChangeRequestUrl: input.autoArchivedChangeRequestUrl ?? null,
    pinnedAt,
    pinGroupId,
    pinGroupAssignedAt,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}

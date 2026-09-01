import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";
import { WorkspacePinGroupSchema, type WorkspacePinGroup } from "@getpaseo/protocol/messages";

import { writeJsonFileAtomic } from "./atomic-file.js";
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
  labels: z.array(z.string()).optional(),
});

const WorkspaceRegistryFileSchema = z.union([
  z.array(PersistedWorkspaceRecordSchema),
  z.object({
    workspaces: z.array(PersistedWorkspaceRecordSchema),
    pinGroups: z.array(WorkspacePinGroupSchema),
  }),
]);

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

  let pinnedAt = workspace.pinnedAt;
  if (pinGroupId === DEFAULT_WORKSPACE_PIN_GROUP_ID && !pinnedAt) {
    pinnedAt = workspace.updatedAt;
  } else if (pinGroupId !== DEFAULT_WORKSPACE_PIN_GROUP_ID) {
    pinnedAt = null;
  }
  return { ...workspace, pinGroupId, pinnedAt };
}

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;

export interface PersistedWorkspaceRegistryFile {
  workspaces: readonly PersistedWorkspaceRecord[];
  pinGroups: readonly WorkspacePinGroup[];
}

interface WorkspaceRegistryPersistenceState {
  pinGroups: Map<string, WorkspacePinGroup>;
  needsMigration: boolean;
}

export interface WorkspaceMutation {
  kind: "upsert" | "archive" | "remove";
  workspaceId: string;
  workspace: PersistedWorkspaceRecord | null;
  expectsInitialAgent?: boolean;
}

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
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
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

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly registryFilePath: string;
  private readonly pinGroupIdFactory: () => string;
  private readonly now: () => string;
  private readonly persistenceState: WorkspaceRegistryPersistenceState;
  private readonly writeRegistryFile: (
    filePath: string,
    registry: PersistedWorkspaceRegistryFile,
  ) => Promise<void>;
  private readonly mutationListeners = new Set<
    (mutation: WorkspaceMutation) => void | Promise<void>
  >();

  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      writeRecords?: (filePath: string, registry: PersistedWorkspaceRegistryFile) => Promise<void>;
      pinGroupIdFactory?: () => string;
      now?: () => string;
    },
  ) {
    const now = options?.now ?? (() => new Date().toISOString());
    const persistenceState: WorkspaceRegistryPersistenceState = {
      pinGroups: new Map(),
      needsMigration: false,
    };
    const writeRegistryFile = options?.writeRecords ?? writeJsonFileAtomic;
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
      parseRecords: (value) => {
        const parsed = WorkspaceRegistryFileSchema.parse(value);
        const isLegacy = Array.isArray(parsed);
        const workspaces = isLegacy ? parsed : parsed.workspaces;
        const storedGroups = isLegacy ? [] : parsed.pinGroups;
        const pinGroups = new Map(storedGroups.map((group) => [group.id, group]));
        const defaultCreatedAt =
          workspaces
            .map((workspace) => workspace.pinnedAt)
            .filter((pinnedAt): pinnedAt is string => pinnedAt !== null)
            .sort()[0] ?? now();
        const storedDefault = pinGroups.get(DEFAULT_WORKSPACE_PIN_GROUP_ID);
        pinGroups.set(DEFAULT_WORKSPACE_PIN_GROUP_ID, {
          id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
          name: DEFAULT_WORKSPACE_PIN_GROUP_NAME,
          createdAt: storedDefault?.createdAt ?? defaultCreatedAt,
        });

        let normalizedMembership = false;
        const normalizedWorkspaces = workspaces.map((workspace) => {
          const normalized = normalizeWorkspacePinMembership(workspace, pinGroups);
          if (
            normalized.pinGroupId !== workspace.pinGroupId ||
            normalized.pinnedAt !== workspace.pinnedAt
          ) {
            normalizedMembership = true;
          }
          return normalized;
        });

        persistenceState.pinGroups = pinGroups;
        persistenceState.needsMigration =
          isLegacy || !storedDefault || storedDefault.name !== DEFAULT_WORKSPACE_PIN_GROUP_NAME;
        persistenceState.needsMigration ||= normalizedMembership;
        return normalizedWorkspaces;
      },
      writeRecords: async (targetPath, records) => {
        await writeRegistryFile(targetPath, {
          workspaces: records,
          pinGroups: Array.from(persistenceState.pinGroups.values()),
        });
      },
    });
    this.registryFilePath = filePath;
    this.pinGroupIdFactory = options?.pinGroupIdFactory ?? generateWorkspacePinGroupId;
    this.now = now;
    this.persistenceState = persistenceState;
    this.writeRegistryFile = writeRegistryFile;
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    if (!this.persistenceState.pinGroups.has(DEFAULT_WORKSPACE_PIN_GROUP_ID)) {
      this.persistenceState.pinGroups.set(DEFAULT_WORKSPACE_PIN_GROUP_ID, {
        id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
        name: DEFAULT_WORKSPACE_PIN_GROUP_NAME,
        createdAt: this.now(),
      });
      this.persistenceState.needsMigration = true;
    }
    if (!this.persistenceState.needsMigration) return;
    await this.mutateCache((records) => records.size, {
      forceRecordWrite: () => true,
    });
    this.persistenceState.needsMigration = false;
  }

  async listPinGroups(): Promise<WorkspacePinGroup[]> {
    await this.initialize();
    return Array.from(this.persistenceState.pinGroups.values()).sort((left, right) => {
      if (left.id === DEFAULT_WORKSPACE_PIN_GROUP_ID) return -1;
      if (right.id === DEFAULT_WORKSPACE_PIN_GROUP_ID) return 1;
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
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
        const updated = { ...workspace, pinGroupId: null, pinnedAt: null, updatedAt };
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
        writeRecords: async (workspaces) => {
          await this.writeRegistryFile(this.registryFilePath, {
            workspaces,
            pinGroups: Array.from(nextPinGroups.values()),
          });
        },
        afterCommit: () => {
          this.persistenceState.pinGroups = nextPinGroups;
        },
      },
    );
    await Promise.all(
      changedWorkspaces.map((workspace) =>
        this.notifyMutation({ kind: "upsert", workspaceId: workspace.workspaceId, workspace }),
      ),
    );
    return value;
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
  labels?: string[];
}): PersistedWorkspaceRecord {
  // COMPAT(workspacePinGroups): added in v0.7.0, remove pinnedAt migration/projection after 2027-03-01.
  const pinGroupId = input.pinGroupId ?? (input.pinnedAt ? DEFAULT_WORKSPACE_PIN_GROUP_ID : null);
  const pinnedAt = pinGroupId === DEFAULT_WORKSPACE_PIN_GROUP_ID ? (input.pinnedAt ?? null) : null;
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

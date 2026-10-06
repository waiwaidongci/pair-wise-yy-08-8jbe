import type { AudioAsset, AudioProject, AssetSource } from '../types/audio';
import { getSyntheticAssetUrl, isSyntheticAsset } from './syntheticAudio';

export const STUDIO_PERSIST_KEY = 'pair-wise-yy-08-studio';
const DB_NAME = 'waveforge-asset-library';
const DB_VERSION = 1;
const STORE_NAME = 'assets';
// 预留 10% 余量，避免逼近浏览器真实配额后写入失败。
const SAFETY_MARGIN = 0.9;

export interface StoredAssetMeta {
  id: string;
  name: string;
  mimeType: string;
  duration: number;
  source: AssetSource;
  size: number;
}

export interface StoredAsset extends StoredAssetMeta {
  blob: Blob;
  createdAt: number;
}

export interface AssetBlobEntry {
  meta: StoredAssetMeta;
  blob: Blob;
}

export interface CapacityReport {
  usage: number;
  quota: number;
  available: number;
}

export interface MigrationResult {
  migrated: number;
  failed: string[];
}

interface PersistedProject {
  assets?: AudioAsset[];
}

interface PersistedState {
  state?: { project?: PersistedProject };
  project?: PersistedProject;
}

export class QuotaRefusedError extends Error {
  files: { name: string; size: number }[];

  constructor(files: { name: string; size: number }[]) {
    const list = files
      .map((file) => `「${file.name}」（${formatBytes(file.size)}）`)
      .join('、');
    super(
      `浏览器素材库空间不足，未能保存 ${list}。请清理浏览器空间或删除不用的素材后重试；当前工程未受影响。`,
    );
    this.name = 'QuotaRefusedError';
    this.files = files;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(head);
  const mimeType = mimeMatch?.[1] ?? 'audio/mpeg';
  if (head.includes('base64')) {
    const binary = atob(body);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(body)], { type: mimeType });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('音频数据读取失败'));
    reader.readAsDataURL(blob);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { name?: string; code?: number };
  return err.name === 'QuotaExceededError' || err.code === 22;
}

class AssetLibrary {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private objectUrls = new Map<string, string>();
  // 已确认写入素材库的素材 id（同步可用），供工程记录持久化时判断是否可剥离内嵌音频。
  private knownStoredIds = new Set<string>();

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDatabase();
    return this.dbPromise;
  }

  isKnownStored(id: string): boolean {
    return this.knownStoredIds.has(id);
  }

  markStored(id: string): void {
    this.knownStoredIds.add(id);
  }

  async capacity(): Promise<CapacityReport> {
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const quota = estimate.quota ?? 0;
        const usage = estimate.usage ?? 0;
        return { usage, quota, available: quota - usage };
      }
    } catch {
      // 容量估算不可用时退化为不限制，写入失败仍会被事务捕获。
    }
    return { usage: 0, quota: 0, available: Number.POSITIVE_INFINITY };
  }

  private async assertCapacity(entries: AssetBlobEntry[]): Promise<void> {
    const total = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
    const { available } = await this.capacity();
    if (Number.isFinite(available) && total > available * SAFETY_MARGIN) {
      throw new QuotaRefusedError(
        entries.map((entry) => ({ name: entry.meta.name, size: entry.blob.size })),
      );
    }
  }

  async has(id: string): Promise<boolean> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getKey(id);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async getBlob(id: string): Promise<Blob | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const record = request.result as StoredAsset | undefined;
        resolve(record?.blob ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getObjectUrl(id: string): Promise<string | null> {
    const cached = this.objectUrls.get(id);
    if (cached) return cached;
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(id, url);
    return url;
  }

  async put(meta: StoredAssetMeta, blob: Blob): Promise<void> {
    await this.putAll([{ meta, blob }]);
  }

  async putAll(entries: AssetBlobEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.assertCapacity(entries);
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        for (const entry of entries) {
          const record: StoredAsset = {
            ...entry.meta,
            blob: entry.blob,
            createdAt: Date.now(),
          };
          store.put(record);
        }
        transaction.oncomplete = () => {
          entries.forEach((entry) => this.knownStoredIds.add(entry.meta.id));
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch (error) {
      if (isQuotaError(error)) {
        throw new QuotaRefusedError(
          entries.map((entry) => ({ name: entry.meta.name, size: entry.blob.size })),
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    this.knownStoredIds.delete(id);
    const url = this.objectUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(id);
    }
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async keys(): Promise<string[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }

  async list(): Promise<StoredAsset[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredAsset[]);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const assetLibrary = new AssetLibrary();

export async function resolveAssetUrl(asset: AudioAsset): Promise<string | null> {
  if (isSyntheticAsset(asset.id)) return getSyntheticAssetUrl(asset.id);
  if (asset.dataUrl) return asset.dataUrl;
  return assetLibrary.getObjectUrl(asset.id);
}

/** 导出工程时把素材库中的音频重新内嵌为 dataUrl，保证 JSON 工程可跨浏览器继续编辑。 */
export async function withEmbeddedAudio(project: AudioProject): Promise<AudioProject> {
  const assets = await Promise.all(
    project.assets.map(async (asset) => {
      if (asset.source === 'synthetic' || asset.dataUrl) return asset;
      const blob = await assetLibrary.getBlob(asset.id);
      if (!blob) return asset;
      return { ...asset, dataUrl: await blobToDataUrl(blob) };
    }),
  );
  return { ...project, assets };
}

/**
 * 启动时把旧版本工程记录里内嵌的 dataUrl 音频迁移到独立素材库，
 * 迁移成功后从 localStorage 记录中剔除音频正文，只保留素材索引。
 */
async function migrateLegacyAssets(): Promise<MigrationResult> {
  if (typeof localStorage === 'undefined' || typeof indexedDB === 'undefined') {
    return { migrated: 0, failed: [] };
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem(STUDIO_PERSIST_KEY);
  } catch {
    return { migrated: 0, failed: [] };
  }
  if (!raw) return { migrated: 0, failed: [] };

  let parsed: PersistedState;
  try {
    parsed = JSON.parse(raw) as PersistedState;
  } catch {
    return { migrated: 0, failed: [] };
  }
  const project = parsed?.state?.project ?? parsed?.project;
  if (!project || !Array.isArray(project.assets)) return { migrated: 0, failed: [] };

  const legacyAssets = project.assets.filter(
    (asset) => typeof asset.dataUrl === 'string' && asset.dataUrl.startsWith('data:'),
  );
  if (!legacyAssets.length) return { migrated: 0, failed: [] };

  // 同步素材库中已有的素材 id，供持久化时判断哪些内嵌音频可以剥离。
  try {
    const existingKeys = await assetLibrary.keys();
    existingKeys.forEach((id) => assetLibrary.markStored(id));
  } catch {
    // 读取失败时退化为仅依据本次迁移结果判断。
  }

  const failed: string[] = [];
  const strippedById = new Map<string, AudioAsset>();
  for (const legacy of legacyAssets) {
    try {
      const blob = dataUrlToBlob(legacy.dataUrl as string);
      const meta: StoredAssetMeta = {
        id: legacy.id,
        name: legacy.name,
        mimeType: legacy.mimeType || blob.type || 'audio/mpeg',
        duration: legacy.duration,
        source: legacy.source,
        size: legacy.size || blob.size,
      };
      await assetLibrary.put(meta, blob);
      const { dataUrl: _dataUrl, ...stripped } = legacy;
      strippedById.set(legacy.id, stripped);
    } catch {
      // 单个素材迁移失败（典型为容量不足）时保留其 dataUrl，避免片段找不到声音。
      failed.push(legacy.name);
    }
  }

  if (strippedById.size > 0) {
    project.assets = project.assets.map((asset) => strippedById.get(asset.id) ?? asset);
    try {
      localStorage.setItem(STUDIO_PERSIST_KEY, JSON.stringify(parsed));
    } catch {
      // 写不回 localStorage 时保留原状，交由下次启动重试。
    }
  }

  return { migrated: strippedById.size, failed };
}

export const migrationReady: Promise<MigrationResult> = migrateLegacyAssets();

export function whenMigrationDone(): Promise<MigrationResult> {
  return migrationReady;
}

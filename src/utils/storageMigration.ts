import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { AudioAsset, AudioProject } from '../types/audio';
import {
  AssetStorageError,
  assertSpaceFor,
  dataUrlToBlob,
  getMediaBlob,
  putMedia,
} from './assetLibrary';

/**
 * 旧版本（v1）把音频以 base64 dataUrl 内嵌在工程记录中，随 localStorage 持久化，
 * 文件稍大就会写爆配额，刷新后工程被重置。本模块负责在打开时把旧音频迁移到
 * IndexedDB 素材库：迁移成功的剥离 dataUrl，失败的保留 dataUrl 兜底播放并标记
 * pendingMigration，下次打开继续重试，绝不出现“有片段却找不到声音”。
 */

export const STORAGE_KEY = 'pair-wise-yy-08-studio';

export interface LegacyMigrationReport {
  migratedCount: number;
  failedNames: string[];
}

let pendingReport: LegacyMigrationReport | null = null;

export function consumeLegacyMigrationReport(): LegacyMigrationReport | null {
  const report = pendingReport;
  pendingReport = null;
  return report;
}

async function migrateAsset(asset: AudioAsset): Promise<boolean> {
  if (asset.source === 'synthetic' || !asset.dataUrl) return false;
  let blob: Blob;
  try {
    blob = dataUrlToBlob(asset.dataUrl);
  } catch {
    return false;
  }
  // 素材库里已有同 id 音频则视为已迁移，只清理内嵌数据。
  const existing = await getMediaBlob(asset.id);
  if (!existing) {
    const meta: AudioAsset = {
      ...asset,
      dataUrl: undefined,
      pendingMigration: undefined,
      size: asset.size ?? blob.size,
    };
    // 空间不够先拒绝迁移，保留内嵌音频兜底，等下次打开重试。
    await assertSpaceFor(blob.size, asset.name);
    await putMedia(meta, blob);
  }
  return true;
}

/**
 * 读取旧持久化记录并迁移其中内嵌的音频。返回迁移后的 JSON 字符串
 * （无变化时原样返回），供自定义 storage 在水合前使用。
 */
export async function migratePersistedState(raw: string): Promise<string> {
  let parsed: { state?: { project?: AudioProject }; version?: number };
  try {
    parsed = JSON.parse(raw) as { state?: { project?: AudioProject }; version?: number };
  } catch {
    return raw;
  }
  const project = parsed.state?.project;
  if (!project || !Array.isArray(project.assets)) return raw;

  const legacyAssets = project.assets.filter(
    (asset) => asset.source !== 'synthetic' && typeof asset.dataUrl === 'string' && asset.dataUrl.length > 0,
  );
  if (legacyAssets.length === 0 && project.version === 2) return raw;

  let migratedCount = 0;
  const failedNames: string[] = [];
  for (const asset of legacyAssets) {
    try {
      const moved = await migrateAsset(asset);
      if (moved) {
        // 只有音频确实进了素材库，才剥离内嵌数据。
        migratedCount += 1;
        delete asset.dataUrl;
        delete asset.pendingMigration;
      } else {
        // dataUrl 损坏等无法解析的情况：原样保留，不破坏可播放性。
        asset.pendingMigration = true;
        failedNames.push(asset.name);
      }
    } catch (error) {
      // 迁移失败：内嵌音频原样保留（仍可播放），下次打开重试。
      asset.pendingMigration = true;
      failedNames.push(asset.name);
      if (error instanceof AssetStorageError && error.reason === 'unavailable') {
        // IndexedDB 不可用，后续素材也不会成功，提前结束。
        break;
      }
    }
  }

  project.version = 2;
  if (migratedCount > 0 || failedNames.length > 0) {
    pendingReport = { migratedCount, failedNames };
  }
  return JSON.stringify(parsed);
}

/** 应用启动时显式执行一次，保证 Store 创建前旧音频已进入素材库。 */
export async function migrateLegacyStorage(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  const migrated = await migratePersistedState(raw);
  // 迁移成功后立即用“只含索引”的新记录替换旧的大体积记录。
  if (migrated !== raw) {
    try {
      localStorage.setItem(STORAGE_KEY, migrated);
    } catch {
      // 写回失败不影响本次会话：水合时自定义 storage 仍会返回迁移结果。
    }
  }
}

// ---------------------------------------------------------------------------
// Zustand 持久化存储：读取时兜底再跑一次迁移（幂等）；写入失败时上报，
// 由 Store 显示“工程未能保存”提示，而不是悄悄丢回初始状态。
// ---------------------------------------------------------------------------

let persistFailureHandler: ((message: string) => void) | null = null;

export function onPersistFailure(handler: (message: string) => void): void {
  persistFailureHandler = handler;
}

const migratingStorage: StateStorage = {
  getItem: async (name) => {
    const raw = localStorage.getItem(name);
    if (raw == null) return raw;
    return migratePersistedState(raw);
  },
  setItem: (name, value) => {
    // 工程记录写满时：内存中的工程保持不变（用户手头工作不丢），
    // 仅全局上报提示；不向上抛错以免产生未处理 rejection。
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      const quota =
        error instanceof DOMException &&
        (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      queueMicrotask(() =>
        persistFailureHandler?.(
          quota ? '浏览器本地存储已满，最新的工程改动未能保存' : '工程自动保存失败',
        ),
      );
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // 忽略删除失败。
    }
  },
};

export const studioStorage = createJSONStorage(() => migratingStorage);

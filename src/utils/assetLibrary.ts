import type { AudioAsset } from '../types/audio';

/**
 * 浏览器独立素材库：音频内容（Blob）存放在 IndexedDB 中，
 * 工程记录（localStorage）只保留素材索引（元数据），
 * 避免 base64 音频撑爆 localStorage 后工程被重置。
 */

const DB_NAME = 'waveforge-asset-library';
const DB_VERSION = 1;
const STORE_MEDIA = 'media';

/** 素材库里实际存放的一条记录：元数据 + 音频 Blob。 */
export interface StoredMedia {
  meta: AudioAsset;
  blob: Blob;
  createdAt: number;
}

/** 容量不足 / 素材库写入被拒绝时抛出，UI 据此给出“未保存文件清单”。 */
export class AssetStorageError extends Error {
  constructor(
    message: string,
    readonly reason: 'quota' | 'unavailable' | 'unknown',
  ) {
    super(message);
    this.name = 'AssetStorageError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new AssetStorageError('当前浏览器不支持 IndexedDB，素材库无法使用', 'unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          db.createObjectStore(STORE_MEDIA, { keyPath: 'meta.id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new AssetStorageError(
            '浏览器素材库打开失败，请检查浏览器的站点数据权限',
            'unavailable',
          ),
        );
    });
  }
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_MEDIA, mode, { durability: 'strict' });
        const request = run(transaction.objectStore(STORE_MEDIA));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(wrapStorageError(request.error));
        transaction.onerror = () => reject(wrapStorageError(transaction.error));
        transaction.onabort = () => reject(wrapStorageError(transaction.error));
      }),
  );
}

function wrapStorageError(error: DOMException | null): AssetStorageError {
  if (isQuotaError(error)) {
    return new AssetStorageError('浏览器存储空间不足，素材库拒绝写入', 'quota');
  }
  return new AssetStorageError(error?.message || '素材库读写失败', 'unknown');
}

function isQuotaError(error: DOMException | null | undefined): boolean {
  if (!error) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}

export async function putMedia(meta: AudioAsset, blob: Blob): Promise<void> {
  const record: StoredMedia = { meta, blob, createdAt: Date.now() };
  await tx('readwrite', (store) => store.put(record));
}

export async function deleteMedia(assetId: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(assetId));
}

export async function getMediaBlob(assetId: string): Promise<Blob | undefined> {
  const record = await tx<StoredMedia | undefined>('readonly', (store) =>
    store.get(assetId) as IDBRequest<StoredMedia | undefined>,
  );
  return record?.blob;
}

/** 列出素材库中的全部素材索引（元数据，不含音频内容）。 */
export async function listMediaMeta(): Promise<AudioAsset[]> {
  const list = await tx<StoredMedia[]>('readonly', (store) =>
    store.getAll() as IDBRequest<StoredMedia[]>,
  );
  return list.map((record) => record.meta);
}

export interface StorageEstimateLike {
  quota?: number;
  usage?: number;
}

/**
 * 写入前的容量预检：浏览器给出配额信息时先判断是否放得下，
 * 放不下直接拒绝，不进行任何写入，调用方据此回滚手头工程。
 * 拿不到配额信息（部分浏览器）时放行，真正写入失败仍会抛 AssetStorageError。
 */
export async function assertSpaceFor(bytes: number, label?: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  let estimate: StorageEstimateLike;
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return;
  }
  const { quota, usage } = estimate;
  if (typeof quota !== 'number' || typeof usage !== 'number') return;
  const headroom = quota - usage;
  // 预留 8% 配额给工程记录（localStorage 与 IDB 同属站点存储池）。
  const reserve = Math.max(2 * 1024 * 1024, Math.floor(quota * 0.08));
  if (bytes + reserve > headroom) {
    const sizeMb = (bytes / 1024 / 1024).toFixed(1);
    const freeMb = (Math.max(0, headroom - reserve) / 1024 / 1024).toFixed(1);
    throw new AssetStorageError(
      `存储空间不足：${label ? `“${label}”需` : '需要'}约 ${sizeMb} MB，素材库仅剩约 ${freeMb} MB 可用`,
      'quota',
    );
  }
}

export function isAssetStorageError(error: unknown): error is AssetStorageError {
  return error instanceof AssetStorageError;
}

// ---------------------------------------------------------------------------
// Blob <-> dataURL 转换（旧数据迁移、工程 JSON 导入导出用）
// ---------------------------------------------------------------------------

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取素材内容失败'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeMatch = /data:([^;,]*)/.exec(header);
  const mimeType = mimeMatch?.[1] || 'application/octet-stream';
  const isBase64 = /;base64/i.test(header) || !header.includes('charset');
  if (isBase64) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(data)], { type: mimeType });
}

// ---------------------------------------------------------------------------
// 播放 / 波形渲染用的 objectURL 缓存
// ---------------------------------------------------------------------------

const objectUrls = new Map<string, string>();

/** 取素材音频的可播放 URL（优先素材库 Blob，其次内嵌 dataUrl），并缓存 objectURL。 */
export async function resolveAssetUrl(asset: AudioAsset): Promise<string> {
  if (asset.dataUrl) return asset.dataUrl;
  const cached = objectUrls.get(asset.id);
  if (cached) return cached;
  const blob = await getMediaBlob(asset.id);
  if (!blob) {
    throw new Error(`素材“${asset.name}”在素材库中不存在`);
  }
  const url = URL.createObjectURL(blob);
  objectUrls.set(asset.id, url);
  return url;
}

export function releaseAssetUrl(assetId: string): void {
  const url = objectUrls.get(assetId);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(assetId);
  }
}

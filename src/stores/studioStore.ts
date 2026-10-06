import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioProjectBundle,
  AudioTrack,
  ClipEffect,
  TrackColor,
} from '../types/audio';
import {
  assertSpaceFor,
  blobToDataUrl,
  dataUrlToBlob,
  deleteMedia,
  getMediaBlob,
  isAssetStorageError,
  listMediaMeta,
  putMedia,
} from '../utils/assetLibrary';
import {
  STORAGE_KEY,
  consumeLegacyMigrationReport,
  onPersistFailure,
  studioStorage,
} from '../utils/storageMigration';
import type { LegacyMigrationReport } from '../utils/storageMigration';
import { SYNTHETIC_ASSETS } from '../utils/syntheticAudio';

const TRACK_COLORS: TrackColor[] = ['#2563eb', '#0f9f7a', '#d97706', '#c2413b', '#7c3aed', '#0891b2'];

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const builtinAssets: AudioAsset[] = SYNTHETIC_ASSETS.map((asset) => ({
  id: asset.id,
  name: asset.name,
  source: 'synthetic',
  duration: asset.duration,
  mimeType: asset.mimeType,
}));

function initialProject(): AudioProject {
  const tracks: AudioTrack[] = [
    {
      id: 'track-drums',
      name: '节奏 / Drums',
      color: '#2563eb',
      volume: 0.78,
      pan: 0,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-drums-a',
          assetId: 'synth-drums',
          name: '紧凑鼓组 A',
          start: 0,
          duration: 8,
          offset: 0,
          fadeIn: 0.05,
          fadeOut: 0.3,
          effect: 'none',
          effectAmount: 0,
        },
      ],
    },
    {
      id: 'track-chords',
      name: '和声 / Chords',
      color: '#0f9f7a',
      volume: 0.58,
      pan: -0.08,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-chords-a',
          assetId: 'synth-chords',
          name: '暖色和弦',
          start: 0,
          duration: 8,
          offset: 0,
          fadeIn: 0.65,
          fadeOut: 0.8,
          effect: 'lowpass',
          effectAmount: 22,
        },
      ],
    },
    {
      id: 'track-bass',
      name: '低频 / Bass',
      color: '#d97706',
      volume: 0.68,
      pan: 0,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-bass-a',
          assetId: 'synth-bass',
          name: '模拟贝斯',
          start: 4,
          duration: 4,
          offset: 0,
          fadeIn: 0.1,
          fadeOut: 0.2,
          effect: 'none',
          effectAmount: 0,
        },
      ],
    },
  ];
  return {
    version: 2,
    name: '未命名工程 · Night Drive',
    bpm: 120,
    snap: 0.25,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,
    pixelsPerSecond: 92,
    tracks,
    assets: builtinAssets,
    updatedAt: Date.now(),
  };
}

/** 容量不足导致的失败信息：全局展示，并列明没存上的文件。 */
export interface StorageFailure {
  message: string;
  failedFiles: string[];
}

/** 启动时旧数据迁移到素材库的结果提示。 */
export type MigrationNotice =
  | { kind: 'success'; migratedCount: number }
  | { kind: 'partial'; migratedCount: number; failedNames: string[] };

interface StudioState {
  project: AudioProject;
  selectedClipId: string | null;
  selectedTrackId: string;
  isPlaying: boolean;
  playhead: number;
  zoom: number;
  projectSavedAt: number;
  /** 素材库（IndexedDB）中缺失的素材名：片段引用了声音却找不到时提示。 */
  missingAssets: string[];
  /** 素材库写满 / 工程记录写满时的失败信息（含未存上的文件清单）。 */
  storageFailure: StorageFailure | null;
  /** 旧数据迁移提示，仅本次打开有效。 */
  migrationNotice: MigrationNotice | null;
  bootstrapped: boolean;
  setPlaying: (playing: boolean) => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  setProjectName: (name: string) => void;
  addTrack: () => void;
  updateTrack: (trackId: string, patch: Partial<AudioTrack>) => void;
  deleteTrack: (trackId: string) => void;
  addClip: (trackId: string, assetId: string, start?: number) => void;
  setClip: (trackId: string, clipId: string, patch: Partial<AudioClip>) => void;
  setClipEffect: (trackId: string, clipId: string, effect: ClipEffect, amount?: number) => void;
  moveClipToTrack: (fromTrackId: string, clipId: string, toTrackId: string, start: number) => void;
  duplicateClip: (trackId: string, clipId: string) => void;
  deleteClip: (trackId: string, clipId: string) => void;
  selectClip: (clipId: string | null) => void;
  updateTransport: (patch: Partial<Pick<AudioProject, 'bpm' | 'snap' | 'loopEnabled' | 'loopStart' | 'loopEnd' | 'pixelsPerSecond'>>) => void;
  importFiles: (files: File[]) => Promise<void>;
  importFile: (file: File) => Promise<void>;
  addRecordedBlob: (blob: Blob, duration: number) => Promise<void>;
  importProjectBundle: (bundle: AudioProjectBundle) => Promise<void>;
  exportProjectBundle: () => Promise<AudioProjectBundle>;
  /** 应用启动：合并素材库索引、检查缺失、上报旧数据迁移结果。 */
  bootstrap: () => Promise<void>;
  dismissStorageFailure: () => void;
  dismissMigrationNotice: () => void;
  replaceProject: (project: AudioProject) => void;
  markSaved: () => void;
}

/** 写入持久化记录前剥掉音频内容：记录里只留轨道、片段和素材索引。 */
function stripAudioPayload(project: AudioProject): AudioProject {
  return {
    ...project,
    assets: project.assets.map((asset) => {
      if (asset.pendingMigration && asset.dataUrl) {
        // 迁移失败的旧素材保留内嵌数据兜底播放，其余一律不进工程记录。
        return asset;
      }
      if (asset.dataUrl) {
        const { dataUrl: _dataUrl, ...meta } = asset;
        return meta;
      }
      return asset;
    }),
  };
}

function normalizeProject(project: AudioProject): AudioProject {
  const customById = new Map(
    project.assets
      .filter((asset) => !builtinAssets.some((builtin) => builtin.id === asset.id))
      .map((asset) => [asset.id, asset]),
  );
  const customAssets = Array.from(customById.values());
  return {
    ...project,
    version: 2,
    tracks: project.tracks.map((track) => ({
      ...track,
      volume: Math.max(0, Math.min(1, track.volume)),
      pan: Math.max(-1, Math.min(1, track.pan)),
      clips: track.clips.map((clip) => ({
        ...clip,
        duration: Math.max(0.02, clip.duration),
        offset: Math.max(0, clip.offset),
        fadeIn: Math.max(0, clip.fadeIn),
        fadeOut: Math.max(0, clip.fadeOut),
        effectAmount: Math.max(0, Math.min(100, clip.effectAmount)),
      })),
    })),
    assets: [...builtinAssets, ...customAssets],
  };
}

function timestamp(project: AudioProject): AudioProject {
  return { ...project, updatedAt: Date.now() };
}

async function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 8;
      resolve(duration);
      audio.src = '';
    };
    audio.onerror = () => reject(new Error('无法读取音频时长或格式不受浏览器支持'));
    audio.src = url;
  });
}

function buildClip(asset: AudioAsset, start: number): AudioClip {
  return {
    id: uid('clip'),
    assetId: asset.id,
    name: asset.name.replace(/^内置 · /, ''),
    start: Math.max(0, start),
    duration: asset.duration,
    offset: 0,
    fadeIn: 0.04,
    fadeOut: 0.12,
    effect: 'none',
    effectAmount: 0,
  };
}

/** 把素材库索引并入工程，并找出“有片段但找不到声音”的素材。 */
function mergeLibraryAndFindMissing(
  project: AudioProject,
  library: AudioAsset[],
): { project: AudioProject; missing: string[] } {
  const libraryById = new Map(library.map((meta) => [meta.id, meta]));
  const known = new Map<string, AudioAsset>();
  for (const asset of project.assets) {
    if (asset.source === 'synthetic') {
      known.set(asset.id, asset);
      continue;
    }
    const stored = libraryById.get(asset.id);
    if (stored) {
      // 素材库已是权威来源：成功迁移后清掉 pendingMigration / 内嵌 dataUrl。
      known.set(asset.id, stored);
    } else {
      known.set(asset.id, asset);
    }
  }
  for (const meta of library) {
    if (!known.has(meta.id)) known.set(meta.id, meta);
  }
  const referencedIds = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
  );
  const missing: string[] = [];
  for (const assetId of referencedIds) {
    const asset = known.get(assetId);
    if (!asset || builtinAssets.some((builtin) => builtin.id === assetId)) continue;
    if (asset.dataUrl) continue; // 旧数据迁移兜底中，仍可播放
    if (!library.some((item) => item.id === assetId)) {
      missing.push(asset.name);
    }
  }
  const customAssets = Array.from(known.values()).filter(
    (asset) => !builtinAssets.some((builtin) => builtin.id === asset.id),
  );
  return {
    project: { ...project, assets: [...builtinAssets, ...customAssets] },
    missing,
  };
}

/** 启动引导只执行一次（StrictMode 双调用 / 水合回调下幂等）。 */
let bootstrapDone = false;

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => {
      const reportStorageFailure = (message: string, failedFiles: string[]) =>
        set({ storageFailure: { message, failedFiles } });

      return {
        project: initialProject(),
        selectedClipId: 'clip-chords-a',
        selectedTrackId: 'track-drums',
        isPlaying: false,
        playhead: 0,
        zoom: 1,
        projectSavedAt: Date.now(),
        missingAssets: [],
        storageFailure: null,
        migrationNotice: null,
        bootstrapped: false,

        setPlaying: (isPlaying) => set({ isPlaying }),
        setPlayhead: (playhead) => set({ playhead: Math.max(0, playhead) }),
        setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(2.2, zoom)) }),
        setProjectName: (name) =>
          set((state) => ({
            project: timestamp({ ...state.project, name: name || '未命名工程' }),
          })),
        addTrack: () =>
          set((state) => {
            const index = state.project.tracks.length;
            const track: AudioTrack = {
              id: uid('track'),
              name: `音频轨 ${index + 1}`,
              color: TRACK_COLORS[index % TRACK_COLORS.length],
              volume: 0.72,
              pan: 0,
              muted: false,
              solo: false,
              height: 112,
              clips: [],
            };
            return {
              selectedTrackId: track.id,
              project: timestamp({ ...state.project, tracks: [...state.project.tracks, track] }),
            };
          }),
        updateTrack: (trackId, patch) =>
          set((state) => ({
            project: timestamp({
              ...state.project,
              tracks: state.project.tracks.map((track) =>
                track.id === trackId ? { ...track, ...patch } : track,
              ),
            }),
          })),
        deleteTrack: (trackId) =>
          set((state) => {
            if (state.project.tracks.length <= 1) return {};
            const tracks = state.project.tracks.filter((track) => track.id !== trackId);
            return {
              selectedTrackId: tracks[0].id,
              selectedClipId: null,
              project: timestamp({ ...state.project, tracks }),
            };
          }),
        addClip: (trackId, assetId, start) =>
          set((state) => {
            const asset = state.project.assets.find((item) => item.id === assetId);
            if (!asset) return {};
            const clip = buildClip(asset, start ?? state.playhead);
            return {
              selectedTrackId: trackId,
              selectedClipId: clip.id,
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((track) =>
                  track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
                ),
              }),
            };
          }),
        setClip: (trackId, clipId, patch) =>
          set((state) => ({
            project: timestamp({
              ...state.project,
              tracks: state.project.tracks.map((track) =>
                track.id === trackId
                  ? {
                      ...track,
                      clips: track.clips.map((clip) =>
                        clip.id === clipId ? { ...clip, ...patch } : clip,
                      ),
                    }
                  : track,
              ),
            }),
          })),
        setClipEffect: (trackId, clipId, effect, amount) =>
          get().setClip(trackId, clipId, {
            effect,
            effectAmount: amount ?? 35,
          }),
        moveClipToTrack: (fromTrackId, clipId, toTrackId, start) =>
          set((state) => {
            const sourceTrack = state.project.tracks.find((track) => track.id === fromTrackId);
            const clip = sourceTrack?.clips.find((item) => item.id === clipId);
            if (!clip) return {};
            const moved = { ...clip, start: Math.max(0, start) };
            return {
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((track) => {
                  if (track.id === fromTrackId && track.id === toTrackId) {
                    return {
                      ...track,
                      clips: track.clips.map((item) => (item.id === clipId ? moved : item)),
                    };
                  }
                  if (track.id === fromTrackId) {
                    return { ...track, clips: track.clips.filter((item) => item.id !== clipId) };
                  }
                  if (track.id === toTrackId) {
                    return { ...track, clips: [...track.clips, moved] };
                  }
                  return track;
                }),
              }),
              selectedTrackId: toTrackId,
              selectedClipId: clipId,
            };
          }),
        duplicateClip: (trackId, clipId) =>
          set((state) => {
            const track = state.project.tracks.find((item) => item.id === trackId);
            const clip = track?.clips.find((item) => item.id === clipId);
            if (!track || !clip) return {};
            const copy = {
              ...clip,
              id: uid('clip'),
              name: `${clip.name} 副本`,
              start: clip.start + clip.duration,
            };
            return {
              selectedClipId: copy.id,
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((item) =>
                  item.id === trackId ? { ...item, clips: [...item.clips, copy] } : item,
                ),
              }),
            };
          }),
        deleteClip: (trackId, clipId) =>
          set((state) => ({
            selectedClipId: null,
            project: timestamp({
              ...state.project,
              tracks: state.project.tracks.map((track) =>
                track.id === trackId
                  ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
                  : track,
              ),
            }),
          })),
        selectClip: (selectedClipId) => set({ selectedClipId }),
        updateTransport: (patch) =>
          set((state) => ({
            project: timestamp({ ...state.project, ...patch }),
          })),

        importFile: async (file) => get().importFiles([file]),

        importFiles: async (files) => {
          if (files.length === 0) return;
          const snapshot = get().project;
          // 先把每个文件转成 Blob/URL 读取元信息，再统一做容量预检：放不下直接拒绝。
          const prepared: { file: File; url: string; asset: AudioAsset }[] = [];
          let totalBytes = 0;
          for (const file of files) {
            const url = URL.createObjectURL(file);
            try {
              const duration = await readAudioDuration(url);
              const asset: AudioAsset = {
                id: uid('asset'),
                name: file.name.replace(/\.[^.]+$/, ''),
                source: 'imported',
                duration,
                mimeType: file.type || 'audio/mpeg',
                size: file.size,
              };
              prepared.push({ file, url, asset });
              totalBytes += file.size;
            } catch (error) {
              URL.revokeObjectURL(url);
              throw new Error(`“${file.name}”无法读取：${error instanceof Error ? error.message : '格式不受支持'}`);
            }
          }

          try {
            await assertSpaceFor(totalBytes, files.map((file) => file.name).join('、'));
            const trackId = get().selectedTrackId || get().project.tracks[0].id;
            const baseStart = get().playhead;
            let cursor = baseStart;
            for (const item of prepared) {
              // 真正写入前再预检一次，并发占用导致中途失败时回滚已写内容。
              await assertSpaceFor(item.file.size, item.file.name);
              await putMedia(item.asset, item.file);
              const clip = buildClip(item.asset, cursor);
              cursor += clip.duration;
              set((state) => ({
                selectedTrackId: trackId,
                selectedClipId: clip.id,
                project: timestamp({
                  ...state.project,
                  assets: state.project.assets.some((known) => known.id === item.asset.id)
                    ? state.project.assets
                    : [...state.project.assets, item.asset],
                  tracks: state.project.tracks.map((track) =>
                    track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
                  ),
                }),
              }));
            }
          } catch (error) {
            // 失败后恢复手头工程，删掉已经写进素材库的部分，并把没存上的文件列出来。
            set({ project: snapshot });
            await Promise.all(
              prepared.map((item) => deleteMedia(item.asset.id).catch(() => undefined)),
            );
            const names = prepared.map((item) => item.asset.name);
            if (isAssetStorageError(error)) {
              reportStorageFailure(error.message, names);
              throw error;
            }
            throw new Error(
              `素材未保存（工程已恢复原样）：${names.join('、')}${error instanceof Error ? `（${error.message}）` : ''}`,
            );
          } finally {
            prepared.forEach((item) => URL.revokeObjectURL(item.url));
          }
        },

        addRecordedBlob: async (blob, duration) => {
          const asset: AudioAsset = {
            id: uid('record'),
            name: `录音 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
            source: 'recorded',
            duration,
            mimeType: blob.type || 'audio/webm',
            size: blob.size,
          };
          try {
            // 容量不够先拒绝写入，不动手头工程。
            await assertSpaceFor(blob.size, asset.name);
            await putMedia(asset, blob);
          } catch (error) {
            if (isAssetStorageError(error)) {
              reportStorageFailure(error.message, [asset.name]);
            }
            throw error instanceof Error ? error : new Error('录音保存失败');
          }
          set((state) => {
            const trackId = state.selectedTrackId || state.project.tracks[0].id;
            const clip = buildClip(asset, state.playhead);
            const project: AudioProject = {
              ...state.project,
              assets: [...state.project.assets, asset],
              tracks: state.project.tracks.map((track) =>
                track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
              ),
              updatedAt: Date.now(),
            };
            return { project, selectedTrackId: trackId, selectedClipId: clip.id };
          });
        },

        importProjectBundle: async (bundle) => {
          if (!Array.isArray(bundle.tracks) || !Array.isArray(bundle.assets)) {
            throw new Error('不是有效的 WaveForge 工程文件');
          }
          const snapshot = get().project;
          const embedded = bundle.assets.filter(
            (asset) => asset.source !== 'synthetic' && typeof asset.dataUrl === 'string',
          );

          let blobs: { asset: AudioAsset; blob: Blob }[] = [];
          try {
            blobs = embedded.map((asset) => ({
              asset: {
                ...asset,
                dataUrl: undefined,
                pendingMigration: undefined,
              },
              blob: dataUrlToBlob(asset.dataUrl as string),
            }));
            const totalBytes = blobs.reduce((sum, item) => sum + item.blob.size, 0);
            await assertSpaceFor(totalBytes, '导入的工程音频');
            for (const item of blobs) {
              await assertSpaceFor(item.blob.size, item.asset.name);
              await putMedia(item.asset, item.blob);
            }
          } catch (error) {
            // 回滚已写入素材与手头工程，列出没存上的文件。
            await Promise.all(
              blobs.map((item) => deleteMedia(item.asset.id).catch(() => undefined)),
            );
            set({ project: snapshot });
            const names = embedded.map((asset) => asset.name);
            if (isAssetStorageError(error)) {
              reportStorageFailure(`工程导入被拒绝：${error.message}`, names);
            }
            throw error instanceof Error ? error : new Error('工程导入失败');
          }

          const importedAssets: AudioAsset[] = bundle.assets.map((asset) => {
            if (asset.source === 'synthetic') return asset;
            const stored = blobs.find((item) => item.asset.id === asset.id);
            return stored ? stored.asset : asset;
          });
          const project = normalizeProject({
            ...bundle,
            version: 2,
            assets: importedAssets,
            updatedAt: Date.now(),
          });
          set({
            project,
            playhead: 0,
            isPlaying: false,
            storageFailure: null,
            selectedClipId: project.tracks.flatMap((track) => track.clips)[0]?.id ?? null,
            selectedTrackId: project.tracks[0]?.id ?? '',
          });
          const library = await listMediaMeta().catch(() => [] as AudioAsset[]);
          const merged = mergeLibraryAndFindMissing(project, library);
          set({ project: timestamp(merged.project), missingAssets: merged.missing });
          void get().markSaved();
        },

        exportProjectBundle: async () => {
          const project = get().project;
          // 导出文件内嵌音频，便于在其他浏览器继续编辑。
          const withPayload = await Promise.all(
            project.assets.map(async (asset): Promise<AudioAsset> => {
              if (asset.source === 'synthetic' || asset.dataUrl) return asset;
              const blob = await getMediaBlob(asset.id);
              if (!blob) return asset;
              return { ...asset, dataUrl: await blobToDataUrl(blob) };
            }),
          );
          return { ...stripAudioPayload(project), version: 2, assets: withPayload };
        },

        bootstrap: async () => {
          if (bootstrapDone) return;
          bootstrapDone = true;
          let report: LegacyMigrationReport | null = null;
          try {
            report = consumeLegacyMigrationReport();
          } catch {
            report = null;
          }
          const library = await listMediaMeta().catch(() => [] as AudioAsset[]);
          set((state) => {
            const merged = mergeLibraryAndFindMissing(state.project, library);
            const notice: MigrationNotice | null =
              report && report.migratedCount > 0
                ? report.failedNames.length > 0
                  ? {
                      kind: 'partial',
                      migratedCount: report.migratedCount,
                      failedNames: report.failedNames,
                    }
                  : { kind: 'success', migratedCount: report.migratedCount }
                : null;
            return {
              project: merged.project,
              missingAssets: merged.missing,
              migrationNotice: notice ?? state.migrationNotice,
              bootstrapped: true,
            };
          });
          // 迁移后用“只含索引”的新记录替换旧的大体积记录。
          if (report) get().markSaved();
        },

        dismissStorageFailure: () => set({ storageFailure: null }),
        dismissMigrationNotice: () => set({ migrationNotice: null }),

        replaceProject: (project) =>
          set({
            project: normalizeProject(project),
            playhead: 0,
            isPlaying: false,
            selectedClipId: project.tracks.flatMap((track) => track.clips)[0]?.id ?? null,
            selectedTrackId: project.tracks[0]?.id ?? '',
          }),
        markSaved: () => set({ projectSavedAt: Date.now() }),
      };
    },
    {
      name: STORAGE_KEY,
      version: 2,
      storage: studioStorage,
      partialize: (state) => ({
        project: stripAudioPayload(state.project),
        zoom: state.zoom,
        selectedClipId: state.selectedClipId,
        selectedTrackId: state.selectedTrackId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<StudioState> | undefined;
        return {
          ...current,
          ...saved,
          project: normalizeProject(saved?.project ?? current.project),
        };
      },
    },
  ),
);

// 工程记录（localStorage）写入失败时全局上报，避免静默丢失改动。
onPersistFailure((message) => {
  useStudioStore.setState((state) => ({
    storageFailure: state.storageFailure ?? { message, failedFiles: [] },
  }));
});

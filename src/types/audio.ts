export type AssetSource = 'synthetic' | 'imported' | 'recorded';
export type TrackColor = '#2563eb' | '#0f9f7a' | '#d97706' | '#c2413b' | '#7c3aed' | '#0891b2';
export type ClipEffect = 'none' | 'lowpass' | 'highpass' | 'echo';

export interface AudioAsset {
  id: string;
  name: string;
  source: AssetSource;
  duration: number;
  mimeType: string;
  /** 仅用于：内置素材的旧版迁移暂存、工程 JSON 导入导出。工程记录里不持久化。 */
  dataUrl?: string;
  size?: number;
  /**
   * 旧数据迁移到 IndexedDB 失败时临时置位：声音仍以内嵌 dataUrl 兜底，
   * 下次打开会继续尝试迁移，避免“有片段却找不到声音”。
   */
  pendingMigration?: boolean;
}

export interface AudioClip {
  id: string;
  assetId: string;
  name: string;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  color: TrackColor;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  height: number;
  clips: AudioClip[];
}

export interface AudioProject {
  version: number;
  name: string;
  bpm: number;
  snap: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  pixelsPerSecond: number;
  tracks: AudioTrack[];
  /** 素材索引（仅元数据），音频内容存放在浏览器独立素材库 IndexedDB 中。 */
  assets: AudioAsset[];
  updatedAt: number;
}

/** 导出 / 旧版导入的工程文件格式，可能携带内嵌音频（v1 一定内嵌）。 */
export type AudioProjectBundle = Omit<AudioProject, 'version'> & {
  version: number;
  assets: AudioAsset[];
};

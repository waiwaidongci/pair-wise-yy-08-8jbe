import {
  Download,
  FolderOpen,
  GraphicEq,
  Save,
} from '@mui/icons-material';
import {
  Alert,
  Button,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AssetLibrary } from '../components/AssetLibrary';
import { ClipInspector } from '../components/ClipInspector';
import { TrackTimeline } from '../components/TrackTimeline';
import { TransportBar } from '../components/TransportBar';
import { useStudioStore } from '../stores/studioStore';
import type { AudioProjectBundle } from '../types/audio';
import { audioEngine } from '../utils/audioEngine';

export function StudioPage() {
  const project = useStudioStore((state) => state.project);
  const isPlaying = useStudioStore((state) => state.isPlaying);
  const playhead = useStudioStore((state) => state.playhead);
  const setPlaying = useStudioStore((state) => state.setPlaying);
  const setPlayhead = useStudioStore((state) => state.setPlayhead);
  const setProjectName = useStudioStore((state) => state.setProjectName);
  const importProjectBundle = useStudioStore((state) => state.importProjectBundle);
  const exportProjectBundle = useStudioStore((state) => state.exportProjectBundle);
  const bootstrap = useStudioStore((state) => state.bootstrap);
  const storageFailure = useStudioStore((state) => state.storageFailure);
  const missingAssets = useStudioStore((state) => state.missingAssets);
  const migrationNotice = useStudioStore((state) => state.migrationNotice);
  const dismissStorageFailure = useStudioStore((state) => state.dismissStorageFailure);
  const dismissMigrationNotice = useStudioStore((state) => state.dismissMigrationNotice);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [recordingPulse, setRecordingPulse] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mixKey = useMemo(
    () =>
      JSON.stringify(
        project.tracks.map((track) => ({
          id: track.id,
          volume: track.volume,
          pan: track.pan,
          muted: track.muted,
          solo: track.solo,
          clips: track.clips.map((clip) => ({
            id: clip.id,
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            effect: clip.effect,
            amount: clip.effectAmount,
          })),
        })),
      ),
    [project.tracks],
  );
  const wasPlayingBeforeMixChange = useRef(false);

  // 等持久化工程水合完成后，再合并浏览器素材库索引、检查片段引用的声音是否齐全。
  useEffect(() => {
    if (useStudioStore.persist.hasHydrated()) {
      void bootstrap();
      return;
    }
    const unlisten = useStudioStore.persist.onFinishHydration(() => {
      void bootstrap();
    });
    return unlisten;
  }, [bootstrap]);

  const beginPlayback = async (from: number) => {
    try {
      const latest = useStudioStore.getState();
      await audioEngine.play(latest.project, Math.max(0, from), () => {
        const state = useStudioStore.getState();
        if (state.project.loopEnabled) {
          void beginPlayback(state.project.loopStart);
        } else {
          setPlaying(false);
          setPlayhead(0);
        }
      });
      setPlaying(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '音频播放初始化失败');
      setPlaying(false);
    }
  };

  const pause = () => {
    const next = audioEngine.getPlayhead();
    audioEngine.stop();
    setPlayhead(next);
    setPlaying(false);
  };

  const stop = () => {
    audioEngine.stop();
    setPlayhead(project.loopEnabled ? project.loopStart : 0);
    setPlaying(false);
  };

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastUpdate = 0;
    const tick = (time: number) => {
      const current = audioEngine.getPlayhead();
      const state = useStudioStore.getState();
      if (state.project.loopEnabled && current >= state.project.loopEnd) {
        audioEngine.stop();
        void beginPlayback(state.project.loopStart);
        return;
      }
      if (time - lastUpdate > 33) {
        setPlayhead(current);
        lastUpdate = time;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, setPlayhead]);

  useEffect(() => {
    if (!isPlaying) {
      wasPlayingBeforeMixChange.current = false;
      return;
    }
    if (wasPlayingBeforeMixChange.current) {
      const current = audioEngine.getPlayhead();
      audioEngine.stop();
      void beginPlayback(current);
    }
    wasPlayingBeforeMixChange.current = true;
  }, [mixKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        isPlaying ? pause() : void beginPlayback(playhead);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, playhead]);

  useEffect(
    () => () => {
      audioEngine.stop();
    },
    [],
  );

  const saveProject = async () => {
    setBusy(true);
    try {
      const bundle = await exportProjectBundle();
      const content = JSON.stringify(bundle, null, 2);
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${project.name.replaceAll('/', '-')}.waveforge.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      useStudioStore.getState().markSaved();
      setMessage('工程 JSON 已导出（内嵌素材库音频），可在其他浏览器中继续编辑。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '工程导出失败');
    } finally {
      setBusy(false);
    }
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as AudioProjectBundle;
      if (
        (parsed.version !== 1 && parsed.version !== 2) ||
        !Array.isArray(parsed.tracks) ||
        !Array.isArray(parsed.assets)
      ) {
        throw new Error('不是有效的 WaveForge 工程文件');
      }
      audioEngine.stop();
      await importProjectBundle(parsed);
      setMessage(`已载入工程：${parsed.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '工程导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-page">
      <header className="studio-heading">
        <div>
          <Typography className="eyebrow">BROWSER AUDIO WORKSTATION</Typography>
          <TextField
            variant="standard"
            value={project.name}
            onChange={(event) => setProjectName(event.target.value)}
            className="project-name"
            inputProps={{ 'aria-label': '工程名称' }}
          />
          <Stack direction="row" alignItems="center" spacing={1}>
            <span className="autosave-dot" />
            <Typography variant="caption" color="text.secondary">
              轨道、片段与素材索引自动保存，音频保存在浏览器素材库
            </Typography>
          </Stack>
        </div>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<FolderOpen />}
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
          >
            导入工程
          </Button>
          <Button variant="outlined" startIcon={<Download />} disabled={busy} onClick={() => void saveProject()}>
            导出工程
          </Button>
          <Button variant="contained" startIcon={<Save />} disabled={busy} onClick={() => void saveProject()}>
            保存
          </Button>
          <input
            ref={importInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void importProject(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </Stack>
      </header>

      <TransportBar
        recording={recordingPulse}
        onPlay={() => void beginPlayback(playhead)}
        onPause={pause}
        onStop={stop}
        onRecord={() => {
          setRecordingPulse(true);
          window.setTimeout(() => setRecordingPulse(false), 1200);
          setMessage('录音入口位于左侧素材库，点击红色录音按钮即可开始。');
        }}
        onSaveProject={() => void saveProject()}
      />

      {storageFailure && (
        <Alert severity="error" className="studio-message" onClose={dismissStorageFailure}>
          {storageFailure.message}，手头工程未被改动。
          {storageFailure.failedFiles.length > 0 && (
            <>
              <br />
              没存上的文件：{storageFailure.failedFiles.join('、')}
            </>
          )}
        </Alert>
      )}

      {migrationNotice && (
        <Alert
          severity={migrationNotice.kind === 'partial' ? 'warning' : 'success'}
          className="studio-message"
          onClose={dismissMigrationNotice}
        >
          {migrationNotice.kind === 'success'
            ? `已把 ${migrationNotice.migratedCount} 个旧音频迁移到浏览器素材库，工程记录现在只保留素材索引。`
            : `已迁移 ${migrationNotice.migratedCount} 个旧音频；${migrationNotice.failedNames.length} 个因空间不足暂未迁移（仍可播放）：${migrationNotice.failedNames.join('、')}`}
        </Alert>
      )}

      {missingAssets.length > 0 && (
        <Alert severity="warning" className="studio-message">
          有 {missingAssets.length} 个片段在素材库中找不到声音：{missingAssets.join('、')}
          。工程与片段已保留，请重新导入对应音频。
        </Alert>
      )}

      {message && (
        <Alert severity="info" className="studio-message" onClose={() => setMessage(null)}>
          {message}
        </Alert>
      )}

      <main className="studio-workspace">
        <AssetLibrary />
        <TrackTimeline />
        <ClipInspector />
      </main>
    </div>
  );
}

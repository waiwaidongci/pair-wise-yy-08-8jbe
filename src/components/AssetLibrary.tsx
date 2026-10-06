import {
  AudioFile,
  FiberManualRecord,
  FolderOpen,
  GraphicEq,
  Mic,
  StopCircle,
  Waves,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useStudioStore } from '../stores/studioStore';
import { SYNTHETIC_ASSETS } from '../utils/syntheticAudio';

function formatSize(bytes?: number): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AssetLibrary() {
  const assets = useStudioStore((state) => state.project.assets);
  const selectedTrackId = useStudioStore((state) => state.selectedTrackId);
  const addClip = useStudioStore((state) => state.addClip);
  const importFiles = useStudioStore((state) => state.importFiles);
  const addRecordedBlob = useStudioStore((state) => state.addRecordedBlob);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartedAt = useRef(0);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () => setRecordSeconds((performance.now() - recordStartedAt.current) / 1000),
      100,
    );
    return () => window.clearInterval(timer);
  }, [recording]);

  const customAssets = assets.filter((asset) => asset.source !== 'synthetic');
  const totalSize = customAssets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const pendingCount = customAssets.filter((asset) => asset.pendingMigration).length;

  const handleImport = async (files?: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await importFiles(list);
    } catch (nextError) {
      // 容量不足已在全局横幅展示并附文件清单，这里不重复弹错。
      if (!useStudioStore.getState().storageFailure) {
        setError(nextError instanceof Error ? nextError.message : '导入音频失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const duration = Math.max(0.2, (performance.now() - recordStartedAt.current) / 1000);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setRecordSeconds(0);
        try {
          await addRecordedBlob(blob, duration);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : '录音保存失败');
        }
      };
      recorder.start(250);
      recorderRef.current = recorder;
      streamRef.current = stream;
      recordStartedAt.current = performance.now();
      setRecordSeconds(0);
      setRecording(true);
    } catch {
      setError('未获得麦克风权限，可使用内置合成音频或导入本地文件。');
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  return (
    <aside className="library-panel">
      <div className="panel-heading">
        <div>
          <Typography variant="subtitle2">素材库</Typography>
          <Typography variant="caption" color="text.secondary">
            音频存放在浏览器素材库，工程只保留索引
          </Typography>
        </div>
        <Chip size="small" label={`${assets.length} 项`} />
      </div>

      <Stack spacing={1} className="record-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <div>
            <Typography variant="body2" fontWeight={700}>录音输入</Typography>
            <Typography variant="caption" color="text.secondary">
              添加为当前所选轨道的新片段
            </Typography>
          </div>
          <Tooltip title={recording ? '停止录音' : '开始录音'}>
            <IconButton
              className={recording ? 'record-button record-button--active' : 'record-button'}
              onClick={recording ? stopRecording : () => void startRecording()}
            >
              {recording ? <StopCircle /> : <FiberManualRecord />}
            </IconButton>
          </Tooltip>
        </Stack>
        {recording && (
          <div className="recording-status">
            <span />
            <strong>正在录音 {recordSeconds.toFixed(1)}s</strong>
            <small>输出到所选轨道</small>
          </div>
        )}
      </Stack>

      <Divider />
      <Typography className="library-label" variant="caption">内置合成片段</Typography>
      <List dense className="asset-list">
        {SYNTHETIC_ASSETS.map((asset) => (
          <ListItem
            key={asset.id}
            secondaryAction={
              <Tooltip title="添加到当前轨道">
                <IconButton edge="end" size="small" onClick={() => addClip(selectedTrackId, asset.id)}>
                  <GraphicEq fontSize="small" />
                </IconButton>
              </Tooltip>
            }
          >
            <ListItemIcon><Waves color="primary" /></ListItemIcon>
            <ListItemText
              primary={asset.name}
              secondary={`${asset.duration}s · ${asset.description}`}
              slotProps={{ secondary: { noWrap: true } }}
            />
          </ListItem>
        ))}
      </List>

      <Divider />
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography className="library-label" variant="caption">素材库音频</Typography>
        {formatSize(totalSize) && (
          <Typography variant="caption" color="text.secondary">{formatSize(totalSize)}</Typography>
        )}
      </Stack>
      <List dense className="asset-list asset-list--scroll">
        {customAssets.map((asset) => {
          const size = formatSize(asset.size);
          return (
            <ListItem
              key={asset.id}
              secondaryAction={
                <Tooltip title="添加到当前轨道">
                  <IconButton edge="end" size="small" onClick={() => addClip(selectedTrackId, asset.id)}>
                    <GraphicEq fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <ListItemIcon>
                {asset.source === 'recorded' ? <Mic color="error" /> : <AudioFile color="success" />}
              </ListItemIcon>
              <ListItemText
                primary={
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <span>{asset.name}</span>
                    {asset.pendingMigration && (
                      <Chip size="small" color="warning" label="迁移待重试" />
                    )}
                  </Stack>
                }
                secondary={`${asset.duration.toFixed(1)}s${size ? ` · ${size}` : ''} · ${asset.source === 'recorded' ? '浏览器录音' : '本地导入'}`}
              />
            </ListItem>
          );
        })}
        {customAssets.length === 0 && (
          <Box className="asset-empty">尚未导入文件，内置素材已经可以直接编辑。</Box>
        )}
      </List>

      {pendingCount > 0 && (
        <Alert severity="warning">
          有 {pendingCount} 个旧素材暂未迁入素材库，当前仍可播放；请释放存储空间后重新打开页面完成迁移。
        </Alert>
      )}

      <Button
        fullWidth
        variant="outlined"
        startIcon={busy ? <CircularProgress size={15} /> : <FolderOpen />}
        disabled={busy || recording}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? '正在写入素材库…' : '导入音频文件（可多选）'}
      </Button>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept="audio/*"
        multiple
        onChange={(event) => {
          void handleImport(event.target.files);
          event.target.value = '';
        }}
      />
      {error && <Alert severity="warning" onClose={() => setError(null)}>{error}</Alert>}
    </aside>
  );
}

import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import type { AudioAsset, AudioClip } from '../types/audio';
import { assetLibrary } from '../utils/assetLibrary';
import { getSyntheticAssetUrl, isSyntheticAsset } from '../utils/syntheticAudio';

interface WaveformClipProps {
  asset: AudioAsset;
  clip: AudioClip;
  pixelsPerSecond: number;
  color: string;
}

function useAssetUrl(asset: AudioAsset): { url: string | null; missing: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setMissing(false);
    if (isSyntheticAsset(asset.id)) {
      setUrl(getSyntheticAssetUrl(asset.id));
      return;
    }
    if (asset.dataUrl) {
      setUrl(asset.dataUrl);
      return;
    }
    void assetLibrary.getObjectUrl(asset.id).then((resolved) => {
      if (cancelled) return;
      if (resolved) {
        setUrl(resolved);
      } else {
        setMissing(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.dataUrl]);

  return { url, missing };
}

export function WaveformClip({ asset, clip, pixelsPerSecond, color }: WaveformClipProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { url: sourceUrl, missing } = useAssetUrl(asset);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!sourceUrl) {
      if (missing) container.dataset.error = '素材音频缺失';
      return;
    }
    delete container.dataset.error;
    const wavesurfer = WaveSurfer.create({
      container,
      height: 58,
      waveColor: `${color}7a`,
      progressColor: color,
      cursorColor: 'transparent',
      cursorWidth: 0,
      barWidth: Math.max(1, Math.min(3, pixelsPerSecond / 42)),
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: false,
      fillParent: false,
      minPxPerSec: pixelsPerSecond,
      hideScrollbar: true,
      autoScroll: false,
      dragToSeek: false,
      backend: 'MediaElement',
    });
    let disposed = false;
    wavesurfer.load(sourceUrl).catch(() => {
      if (!disposed) container.dataset.error = '波形不可用';
    });
    return () => {
      disposed = true;
      wavesurfer.destroy();
    };
  }, [sourceUrl, missing, clip.offset, color, pixelsPerSecond]);

  return (
    <div className="waveform-clip" aria-label={`${clip.name} 波形`}>
      <div
        className="waveform-canvas"
        ref={containerRef}
        style={{
          width: `${Math.max(20, asset.duration * pixelsPerSecond)}px`,
          transform: `translateX(${-clip.offset * pixelsPerSecond}px)`,
        }}
      />
    </div>
  );
}

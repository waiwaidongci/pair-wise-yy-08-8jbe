import { ErrorOutline } from '@mui/icons-material';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import type { AudioAsset, AudioClip } from '../types/audio';
import { resolveAssetUrl } from '../utils/assetLibrary';
import { getSyntheticAssetUrl, isSyntheticAsset } from '../utils/syntheticAudio';

interface WaveformClipProps {
  asset: AudioAsset;
  clip: AudioClip;
  pixelsPerSecond: number;
  color: string;
}

export function WaveformClip({ asset, clip, pixelsPerSecond, color }: WaveformClipProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    delete container.dataset.error;
    let disposed = false;

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

    void (async () => {
      let sourceUrl: string;
      try {
        if (isSyntheticAsset(asset.id)) {
          sourceUrl = getSyntheticAssetUrl(asset.id);
        } else if (asset.dataUrl) {
          sourceUrl = asset.dataUrl;
        } else {
          sourceUrl = await resolveAssetUrl(asset);
        }
      } catch {
        if (!disposed) {
          container.dataset.error = '声音缺失';
          setMissing(true);
        }
        return;
      }
      if (disposed) return;
      setMissing(false);
      try {
        await wavesurfer.load(sourceUrl);
      } catch {
        if (!disposed) container.dataset.error = '波形不可用';
      }
    })();

    return () => {
      disposed = true;
      wavesurfer.destroy();
    };
  }, [asset, color, pixelsPerSecond]);

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
      {missing && (
        <span className="waveform-missing" title={`素材“${asset.name}”在素材库中缺失`}>
          <ErrorOutline fontSize="inherit" /> 声音缺失
        </span>
      )}
    </div>
  );
}

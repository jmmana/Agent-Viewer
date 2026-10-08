import React, { useId, useMemo } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { createOfficeTranslator, type HostTranslate, type OfficeMessages } from '../content/officeMessages';
import type { EventReplay } from './useEventReplay';

export interface ReplayControlsProps {
  replay: EventReplay;
  /** Speeds offered to the viewer. */
  speeds?: readonly number[];
  locale?: string;
  messages?: Partial<OfficeMessages>;
  t?: HostTranslate;
  theme?: 'dark' | 'light';
  className?: string;
}

const DEFAULT_SPEEDS = [1, 2, 4] as const;

/** Optional play, pause, seek and speed controls for `useEventReplay`. Hosts can build their own instead. */
export const ReplayControls: React.FC<ReplayControlsProps> = ({
  replay,
  speeds = DEFAULT_SPEEDS,
  locale = 'en',
  messages,
  t,
  theme = 'dark',
  className,
}) => {
  const translate = useMemo(() => createOfficeTranslator({ locale, messages, t }), [locale, messages, t]);
  const speedLegendId = useId();
  const percent = Math.round(replay.progress * 100);
  const rootClass = ['av-replay', `av-theme-${theme}`, className].filter(Boolean).join(' ');

  return (
    <div className={rootClass} role="group" aria-label={translate('replay.label')}>
      <button
        type="button"
        className="av-replay-btn av-replay-btn--primary"
        onClick={replay.toggle}
        disabled={replay.total === 0}
        aria-label={translate(replay.playing ? 'replay.pause' : 'replay.play')}
        title={translate(replay.playing ? 'replay.pause' : 'replay.play')}
      >
        {replay.playing ? <Pause className="av-icon" aria-hidden="true" /> : <Play className="av-icon" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="av-replay-btn"
        onClick={replay.reset}
        disabled={replay.total === 0}
        aria-label={translate('replay.reset')}
        title={translate('replay.reset')}
      >
        <RotateCcw className="av-icon" aria-hidden="true" />
      </button>
      <input
        type="range"
        className="av-replay-range"
        min={0}
        max={1}
        step={0.001}
        value={replay.progress}
        onChange={(event) => replay.seek(Number(event.target.value))}
        disabled={replay.total === 0}
        aria-label={translate('replay.position')}
        aria-valuetext={translate('replay.progress', { percent })}
      />
      <span className="av-replay-progress" aria-hidden="true">
        {translate('replay.progress', { percent })}
      </span>
      <fieldset className="av-replay-speed" aria-labelledby={speedLegendId}>
        <legend id={speedLegendId}>{translate('replay.speed')}</legend>
        {speeds.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={replay.speed === value}
            onClick={() => replay.setSpeed(value)}
          >
            {translate('replay.speedValue', { speed: value })}
          </button>
        ))}
      </fieldset>
    </div>
  );
};

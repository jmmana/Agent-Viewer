/**
 * Simulator tab (issue #79): a sandbox that never touches real data. The permanent banner and the demo-catalog
 * price disclaimer are shown unconditionally, in both `ledger` and `simulated` mode. The model list is the demo
 * catalog only (`MODEL_CATALOG`): a model only observed on the real ledger has no known price here, so it is
 * never offered as a simulation target. Firing a burst never makes a network request; the caller
 * (`ModelOpsModal`) wires `onFire` to a callback that only ever updates local, isolated simulator state (issue
 * #57), regardless of mode.
 */
import React from 'react';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { MODEL_CATALOG, calculateModelCost, getModelSpec, type SimulatedCallPreset } from '../../engine/modelOps';
import { Info, Play, Zap } from 'lucide-react';

type MessageParams = Record<string, string | number>;

const SimulatedBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">
    {label}
  </span>
);

export interface SimulatorTabProps {
  locale: Locale;
  selectedModel: string;
  onSelectedModelChange: (modelId: string) => void;
  selectedPreset: SimulatedCallPreset;
  onApplyPreset: (preset: 'chat' | 'code' | 'rag' | 'batch') => void;
  inputTokens: number;
  onInputTokensChange: (value: number) => void;
  outputTokens: number;
  onOutputTokensChange: (value: number) => void;
  cacheHitRatio: number;
  onFire: (modelId: string, provider: string, preset: SimulatedCallPreset) => void;
}

export const SimulatorTab: React.FC<SimulatorTabProps> = ({
  locale,
  selectedModel,
  onSelectedModelChange,
  selectedPreset,
  onApplyPreset,
  inputTokens,
  onInputTokensChange,
  outputTokens,
  onOutputTokensChange,
  cacheHitRatio,
  onFire,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);
  const catalogModels = Object.values(MODEL_CATALOG);
  const spec = getModelSpec(selectedModel);
  const cachedTokens = Math.round(inputTokens * cacheHitRatio);
  const estimatedCost = calculateModelCost(selectedModel, inputTokens, outputTokens, cachedTokens);
  const totalTokensInBurst = inputTokens + outputTokens;

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-br from-slate-950 to-cyan-950/40 p-6 rounded-2xl border border-cyan-500/40 space-y-6">
        <div>
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan-400" aria-hidden="true" />
            <span>{tr('ops.sim.heading')}</span>
          </h3>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{tr('ops.sim.intro')}</p>
        </div>

        {/* Permanent banner (issue #79): shown unconditionally, in ledger mode too. A burst never leaves this tab. */}
        <div role="note" className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200 text-[11px]">
          <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.sim.banner')}</span>
        </div>

        <div className="space-y-2">
          <span id="av-modelops-presets-label" className="text-xs text-slate-300 font-medium block">{tr('ops.sim.presets')}</span>
          <div role="group" aria-labelledby="av-modelops-presets-label" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <button type="button" onClick={() => onApplyPreset('chat')} className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors">
              <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.chat')}</span>
              <span className="text-[11px] text-slate-400 block mt-0.5">{tr('ops.sim.presetSplit', { input: '450', output: '180' })}</span>
              <span className="text-[10px] text-cyan-400 font-mono mt-1 block">{tr('ops.sim.presetTotal', { tokens: '630' })}</span>
            </button>
            <button type="button" onClick={() => onApplyPreset('code')} className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors">
              <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.code')}</span>
              <span className="text-[11px] text-slate-400 block mt-0.5">{tr('ops.sim.presetSplit', { input: '2.4K', output: '850' })}</span>
              <span className="text-[10px] text-cyan-400 font-mono mt-1 block">{tr('ops.sim.presetTotalCache', { tokens: '3.25K', ratio: 35 })}</span>
            </button>
            <button type="button" onClick={() => onApplyPreset('rag')} className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors">
              <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.rag')}</span>
              <span className="text-[11px] text-slate-400 block mt-0.5">{tr('ops.sim.presetSplit', { input: '9.8K', output: '1.4K' })}</span>
              <span className="text-[10px] text-cyan-400 font-mono mt-1 block">{tr('ops.sim.presetTotalCache', { tokens: '11.2K', ratio: 55 })}</span>
            </button>
            <button type="button" onClick={() => onApplyPreset('batch')} className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors">
              <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.batch')}</span>
              <span className="text-[11px] text-slate-400 block mt-0.5">{tr('ops.sim.presetSplit', { input: '32K', output: '4.8K' })}</span>
              <span className="text-[10px] text-cyan-400 font-mono mt-1 block">{tr('ops.sim.presetTotalCache', { tokens: '36.8K', ratio: 70 })}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
          <div>
            <label htmlFor="av-modelops-sim-model" className="text-[11px] text-slate-300 font-medium block mb-1.5">{tr('ops.sim.targetModel')}</label>
            <select
              id="av-modelops-sim-model"
              value={selectedModel}
              onChange={(event) => onSelectedModelChange(event.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
            >
              {catalogModels.map((item) => (
                <option key={item.id} value={item.id}>{item.provider} · {item.id}</option>
              ))}
            </select>
            {spec ? (
              <p className="text-[10px] text-slate-400 mt-1 font-mono">
                {tr('ops.sim.rate', { input: spec.inputPer1M, output: spec.outputPer1M })} <span className="text-slate-500">({tr('ops.sim.estimatedLabel')})</span>
              </p>
            ) : (
              <p className="text-[10px] text-slate-400 mt-1 font-mono">{tr('ops.sim.rateUnknown')}</p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <label htmlFor="av-modelops-sim-input" className="text-slate-300 font-medium">{tr('ops.sim.inputTokens')}</label>
              <span className="text-sky-300 font-mono font-bold">{inputTokens.toLocaleString()} t</span>
            </div>
            <input
              id="av-modelops-sim-input"
              type="range"
              min={100}
              max={40000}
              step={100}
              value={inputTokens}
              onChange={(event) => onInputTokensChange(Number(event.target.value))}
              className="w-full accent-cyan-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <label htmlFor="av-modelops-sim-output" className="text-slate-300 font-medium">{tr('ops.sim.outputTokens')}</label>
              <span className="text-emerald-300 font-mono font-bold">{outputTokens.toLocaleString()} t</span>
            </div>
            <input
              id="av-modelops-sim-output"
              type="range"
              min={50}
              max={8000}
              step={50}
              value={outputTokens}
              onChange={(event) => onOutputTokensChange(Number(event.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900 border border-cyan-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-medium">{tr('ops.sim.summary')}</span>
              <SimulatedBadge label={tr('ops.badge.simulated')} />
            </div>
            <div className="flex items-center gap-3 font-mono text-xs flex-wrap">
              <span className="text-white font-bold">{tr('ops.sim.totalTokens', { value: totalTokensInBurst.toLocaleString() })}</span>
              <span className="text-sky-400">{tr('ops.tokens.inValue', { value: inputTokens.toLocaleString() })}</span>
              <span className="text-emerald-400">{tr('ops.tokens.outValue', { value: outputTokens.toLocaleString() })}</span>
              <span className="text-purple-400">{tr('ops.sim.cachedValue', { value: cachedTokens.toLocaleString() })}</span>
              <span className="text-emerald-300 font-bold">
                {estimatedCost === null ? tr('ops.value.unknown') : tr('ops.sim.costValue', { value: estimatedCost.toFixed(5) })}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              const provider = spec?.provider ?? catalogModels[0].provider;
              onFire(selectedModel, provider, selectedPreset);
            }}
            className="px-6 py-2.5 bg-gradient-to-r from-cyan-700 via-sky-700 to-indigo-600 hover:from-cyan-600 hover:to-indigo-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-xl shadow-cyan-950 transition-all active:scale-95 shrink-0"
          >
            <Play className="w-4 h-4 fill-current" aria-hidden="true" />
            <span>{tr('ops.sim.fire')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

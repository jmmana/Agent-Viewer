import React, { useState } from 'react';
import { PricingConfig } from '../types/agent';
import { isSoundEnabled, setSoundEnabled } from '../engine/soundEffects';
import { X, DollarSign, Shield, Volume2, RotateCcw, Download, Coffee } from 'lucide-react';
import type { Locale } from '../i18n';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  pricing: PricingConfig[];
  onUpdatePricing: (pricing: PricingConfig[]) => void;
  onResetSession: () => void;
  onExportSession: () => void;
  ambientSocialEnabled: boolean;
  onAmbientSocialEnabledChange: (enabled: boolean) => void;
  politicsChatterEnabled: boolean;
  onPoliticsChatterEnabledChange: (enabled: boolean) => void;
  locale: Locale;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  pricing,
  onUpdatePricing,
  onResetSession,
  onExportSession,
  ambientSocialEnabled,
  onAmbientSocialEnabledChange,
  politicsChatterEnabled,
  onPoliticsChatterEnabledChange,
}) => {
  const [localPricing, setLocalPricing] = useState<PricingConfig[]>(pricing);
  const [maskSecrets, setMaskSecrets] = useState(true);
  const [soundActive, setSoundActive] = useState(isSoundEnabled());

  if (!isOpen) return null;

  const handlePriceChange = (index: number, field: keyof PricingConfig, val: number) => {
    const updated = [...localPricing];
    (updated[index] as any)[field] = val;
    setLocalPricing(updated);
  };

  const handleSave = () => {
    onUpdatePricing(localPricing);
    setSoundEnabled(soundActive);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100 max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div>
            <h3 className="text-sm font-bold text-white">Agent Viewer Settings & Pricing</h3>
            <p className="text-xs text-slate-400">Configure LLM pricing catalog, privacy filters, and telemetry</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scroll Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* Section: Pricing Catalog */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-400" />
              <h4 className="font-semibold text-slate-200">LLM Model Pricing Catalog ($ / 1M Tokens)</h4>
            </div>
            <p className="text-slate-400 text-[11px]">
              Set custom token rates to calculate real-time cost observability. Set to $0 for local Ollama/LM Studio models.
            </p>

            <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] text-slate-400 bg-slate-900/40">
                    <th className="py-2.5 px-3">Provider</th>
                    <th className="py-2.5 px-3">Model</th>
                    <th className="py-2.5 px-3 text-right">Input ($/M)</th>
                    <th className="py-2.5 px-3 text-right">Output ($/M)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {localPricing.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-900/30">
                      <td className="py-2 px-3 text-slate-400 font-sans">{item.provider}</td>
                      <td className="py-2 px-3 font-semibold text-slate-200">{item.model}</td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={item.inputPerMillion}
                          onChange={(e) => handlePriceChange(idx, 'inputPerMillion', parseFloat(e.target.value) || 0)}
                          className="w-20 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-right text-emerald-400 text-xs focus:outline-none"
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={item.outputPerMillion}
                          onChange={(e) => handlePriceChange(idx, 'outputPerMillion', parseFloat(e.target.value) || 0)}
                          className="w-20 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-right text-emerald-400 text-xs focus:outline-none"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section: Privacy & Security Filter */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-sky-400" />
              <h4 className="font-semibold text-slate-200">Privacy & Secret Sanitization</h4>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={maskSecrets}
                onChange={(e) => setMaskSecrets(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">Sanitize Passwords, Tokens & Tool Arguments</span>
                <span className="text-[11px] text-slate-400">
                  Automatically masks bearer tokens, AWS credentials, and database secrets in the UI.
                </span>
              </div>
            </label>
          </div>

          {/* Section: Audio Feedback */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-amber-400" />
              <h4 className="font-semibold text-slate-200">Synthesized Web Audio</h4>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={soundActive}
                onChange={(e) => setSoundActive(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">Play Subtle Sonic Cues</span>
                <span className="text-[11px] text-slate-400">
                  Unobtrusive Web Audio oscillator chimes for task completions, meetings, and blocker warnings.
                </span>
              </div>
            </label>
          </div>

          {/* Section: Living Office */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Coffee className="w-4 h-4 text-amber-400" />
              <h4 className="font-semibold text-slate-200">Living Office</h4>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={ambientSocialEnabled}
                onChange={(e) => onAmbientSocialEnabledChange(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">Ambient social life</span>
                <span className="text-[11px] text-slate-400">
                  Idle agents may walk to the espresso bar, tell jokes, chat and show lightweight moods.
                </span>
              </div>
            </label>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={politicsChatterEnabled}
                onChange={(e) => onPoliticsChatterEnabledChange(e.target.checked)}
                disabled={!ambientSocialEnabled}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4 disabled:opacity-50"
              />
              <div>
                <span className="font-semibold text-slate-200 block">Allow politics as an ambient topic</span>
                <span className="text-[11px] text-slate-400">
                  Off by default. Built-in dialogue stays generic; future live news must carry source and timestamp metadata.
                </span>
              </div>
            </label>
          </div>

          {/* Section: Session Management */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <h4 className="font-semibold text-slate-200">Session Controls</h4>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onExportSession}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Session JSON</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onResetSession();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-900/40 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Simulation State</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/60 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

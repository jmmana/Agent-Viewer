import React, { useId, useState } from 'react';
import { PricingConfig } from '../types/agent';
import { isSoundEnabled, setSoundEnabled } from '../engine/soundEffects';
import { X, DollarSign, Shield, Volume2, RotateCcw, Download, Coffee, Eye } from 'lucide-react';
import type { Locale } from '../i18n';
import { t } from '../i18n';

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
  /** Display preference (issue #78), lifted out of this modal's own state so other usage surfaces (the call
   * detail panel) can read it too. Persisted in `localStorage` by the caller. */
  maskSecrets: boolean;
  onMaskSecretsChange: (masked: boolean) => void;
  /** Display preference (issue #78): hides the per-agent spend badges on the office canvas. The top-bar total
   * is never gated by this. */
  showUsageBadges: boolean;
  onShowUsageBadgesChange: (show: boolean) => void;
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
  maskSecrets,
  onMaskSecretsChange,
  showUsageBadges,
  onShowUsageBadgesChange,
  locale,
}) => {
  const [localPricing, setLocalPricing] = useState<PricingConfig[]>(pricing);
  const [soundActive, setSoundActive] = useState(isSoundEnabled());
  const titleId = useId();

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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100 max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div>
            <h2 id={titleId} className="text-sm font-bold text-white">{t(locale, 'settings.title')}</h2>
            <p className="text-xs text-slate-400">{t(locale, 'settings.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(locale, 'settings.close')}
            title={t(locale, 'settings.close')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scroll Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* Section: Pricing Catalog */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <h3 className="font-semibold text-slate-200">{t(locale, 'settings.pricingTitle')}</h3>
            </div>
            <p className="text-slate-400 text-[11px]">
              {t(locale, 'settings.pricingHelp')}
            </p>

            <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] text-slate-400 bg-slate-900/40">
                    <th scope="col" className="py-2.5 px-3">{t(locale, 'settings.provider')}</th>
                    <th scope="col" className="py-2.5 px-3">{t(locale, 'settings.model')}</th>
                    <th scope="col" className="py-2.5 px-3 text-right">{t(locale, 'settings.inputPrice')}</th>
                    <th scope="col" className="py-2.5 px-3 text-right">{t(locale, 'settings.outputPrice')}</th>
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
                          aria-label={t(locale, 'settings.inputPriceFor', { model: item.model })}
                          onChange={(e) => handlePriceChange(idx, 'inputPerMillion', parseFloat(e.target.value) || 0)}
                          className="w-20 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-right text-emerald-400 text-xs focus:outline-none"
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={item.outputPerMillion}
                          aria-label={t(locale, 'settings.outputPriceFor', { model: item.model })}
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
              <Shield className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <h3 className="font-semibold text-slate-200">{t(locale, 'settings.privacyTitle')}</h3>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={maskSecrets}
                onChange={(e) => onMaskSecretsChange(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">{t(locale, 'settings.privacyLabel')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'settings.privacyHelp')}
                </span>
              </div>
            </label>
          </div>

          {/* Section: Usage display (issue #78) */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <h3 className="font-semibold text-slate-200">{t(locale, 'settings.usageDisplayTitle')}</h3>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={showUsageBadges}
                onChange={(e) => onShowUsageBadgesChange(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">{t(locale, 'settings.showUsageBadgesLabel')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'settings.showUsageBadgesHelp')}
                </span>
              </div>
            </label>
          </div>

          {/* Section: Audio Feedback */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h3 className="font-semibold text-slate-200">{t(locale, 'settings.audioTitle')}</h3>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={soundActive}
                onChange={(e) => setSoundActive(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">{t(locale, 'settings.audioLabel')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'settings.audioHelp')}
                </span>
              </div>
            </label>
          </div>

          {/* Section: Living Office */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <Coffee className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h3 className="font-semibold text-slate-200">{t(locale, 'settings.livingOffice')}</h3>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={ambientSocialEnabled}
                onChange={(e) => onAmbientSocialEnabledChange(e.target.checked)}
                className="rounded border-slate-700 text-indigo-600 focus:ring-0 w-4 h-4"
              />
              <div>
                <span className="font-semibold text-slate-200 block">{t(locale, 'settings.ambient')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'settings.ambientHelp')}
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
                <span className="font-semibold text-slate-200 block">{t(locale, 'settings.politics')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'settings.politicsHelp')}
                </span>
              </div>
            </label>
          </div>

          {/* Section: Session Management */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <h3 className="font-semibold text-slate-200">{t(locale, 'settings.session')}</h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onExportSession}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t(locale, 'settings.export')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onResetSession();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-900/40 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t(locale, 'settings.reset')}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/60 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg transition-colors"
          >
            {t(locale, 'settings.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm"
          >
            {t(locale, 'settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
};

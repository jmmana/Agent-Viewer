import { RefreshCw, X } from 'lucide-react';
import { t, type Locale } from '../i18n';

/**
 * Shown after the live stream resyncs (issue #54): the server could not replay everything the client missed,
 * so the office was reloaded from a fresh snapshot. Never blocks the office, and never shows `0` for an unknown
 * `missed` count, only "unknown" (through `resync.bodyUnknown`), since the server itself never reports `0` when
 * it does not know.
 */
export function ResyncNotice({ locale, missed, onDismiss }: { locale: Locale; missed: number | null; onDismiss: () => void }) {
  return (
    <section
      role="status"
      className="flex items-start gap-3 border-b border-sky-500/40 bg-sky-950/70 px-4 py-3 text-sky-100"
    >
      <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{t(locale, 'resync.title')}</p>
        <p className="mt-0.5">
          {missed === null ? t(locale, 'resync.bodyUnknown') : t(locale, 'resync.bodyKnown', { count: missed })}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t(locale, 'resync.dismiss')}
        title={t(locale, 'resync.dismiss')}
        className="shrink-0 text-sky-300 hover:text-white"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

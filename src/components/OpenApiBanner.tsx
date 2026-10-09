import { ShieldAlert } from 'lucide-react';
import { t, type Locale } from '../i18n';

const SECURITY_DOCS_URL = 'https://github.com/jmmana/Agent-Viewer#-security';

export function OpenApiBanner({ locale }: { locale: Locale }) {
  return (
    <section
      role="alert"
      className="flex items-start gap-3 border-b border-amber-500/40 bg-amber-950/70 px-4 py-3 text-amber-100"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{t(locale, 'security.openApi.title')}</p>
        <p className="mt-0.5">{t(locale, 'security.openApi.body')}</p>
        <p className="mt-1 font-medium">
          {t(locale, 'security.openApi.action')}{' '}
          <a
            href={SECURITY_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-white"
          >
            {t(locale, 'security.openApi.docsLink')}
          </a>
        </p>
      </div>
    </section>
  );
}

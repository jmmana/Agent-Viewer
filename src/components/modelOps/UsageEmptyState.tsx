import React from 'react';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { AlertCircle, Filter, Inbox, Loader2, Lock, ServerCrash } from 'lucide-react';

/**
 * The seven empty/error states of the ledger-backed Model Ops tabs (issue #79), shown instead of a table
 * whenever a tab's data is missing, so Matrix, Agents and Feed never silently show zero. `truncated` (the
 * rollup's own "showing the top N groups" notice) is not here: it is shown alongside a non-empty table, not in
 * its place (see `MatrixTab`'s own truncation banner).
 */
export type UsageEmptyStateKind = 'loading' | 'unavailable' | 'unauthorized' | 'error' | 'empty' | 'filtered';

type MessageParams = Record<string, string | number>;

export interface UsageEmptyStateProps {
  kind: UsageEmptyStateKind;
  locale: Locale;
  /** Required for `kind === 'empty'`: the resolved API base the copy-ready snippets echo back. */
  apiBase?: string;
  /** `kind === 'error'` detail text, shown under the generic message. */
  errorMessage?: string;
  onRetry?: () => void;
  onClearFilters?: () => void;
}

/** A complete, valid V1 envelope (the endpoint validates it against `validateCanonicalEvent`): `id`, `timestamp`,
 * `source` and `summary` are required, and the `llm.usage` payload needs `provider`, `model`, `inputTokens` and
 * `outputTokens`. Never carries a token value: the snippet uses a shell variable, not a literal secret. */
function buildCurlSnippet(apiBase: string): string {
  const body = {
    schemaVersion: '1.0',
    id: 'evt_demo_1',
    type: 'llm.usage',
    timestamp: Date.now(),
    source: 'agent:demo',
    agentId: 'demo',
    summary: 'demo call',
    payload: { provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 1200, outputTokens: 300 },
  };
  return [
    `curl -X POST ${apiBase}/api/v1/events \\`,
    '  -H "Authorization: Bearer $AGENT_VIEWER_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

const PYTHON_SNIPPET = "agent.usage(provider='anthropic', model='claude-sonnet-4-5', input_tokens=1200, output_tokens=300)";
const TYPESCRIPT_SNIPPET =
  "agent.usage({ provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 1200, outputTokens: 300 })";

const INTEGRATION_DOCS_URL = 'https://github.com/jmmana/Agent-Viewer/blob/main/docs/integration.md';

export const UsageEmptyState: React.FC<UsageEmptyStateProps> = ({
  kind,
  locale,
  apiBase,
  errorMessage,
  onRetry,
  onClearFilters,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  if (kind === 'loading') {
    return (
      <div
        role="status"
        aria-busy="true"
        className="p-5 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
      >
        <div className="flex items-center gap-2 text-slate-400 text-[11px]">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" aria-hidden="true" />
          <span>{tr('ops.empty.loading')}</span>
        </div>
        <div className="h-3 w-1/3 bg-slate-800 rounded animate-pulse" />
        <div className="h-3 w-2/3 bg-slate-800 rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-slate-800 rounded animate-pulse" />
      </div>
    );
  }

  if (kind === 'unavailable') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
        <ServerCrash className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{tr('ops.empty.unavailable')}</span>
      </div>
    );
  }

  if (kind === 'unauthorized') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
        <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{tr('ops.empty.unauthorized')}</span>
      </div>
    );
  }

  if (kind === 'error') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-red-900/60 text-slate-300 space-y-2 text-xs">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {tr('ops.empty.networkError')}
            {errorMessage ? `: ${errorMessage}` : ''}
          </span>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium border border-slate-700/60 transition-colors"
          >
            {tr('ops.empty.retry')}
          </button>
        )}
      </div>
    );
  }

  if (kind === 'filtered') {
    return (
      <div
        role="status"
        className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-center justify-between gap-3 flex-wrap text-xs"
      >
        <span className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" aria-hidden="true" />
          {tr('ops.empty.filtered')}
        </span>
        {onClearFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium border border-slate-700/60 transition-colors"
          >
            {tr('ops.empty.clearFilters')}
          </button>
        )}
      </div>
    );
  }

  // kind === 'empty': the ledger holds no calls at all, no filters applied.
  const base = apiBase ?? '';
  return (
    <div role="status" className="p-5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Inbox className="w-4 h-4 text-cyan-400" aria-hidden="true" />
        <span className="font-semibold text-white">{tr('ops.empty.noCalls.heading')}</span>
      </div>
      <p className="text-slate-400">{tr('ops.empty.noCalls.intro')}</p>

      <div className="space-y-1">
        <p className="text-[11px] text-slate-400 font-medium">{tr('ops.empty.noCalls.curlHeading')}</p>
        <pre className="text-[10px] bg-slate-900 border border-slate-800 rounded-lg p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
          {buildCurlSnippet(base)}
        </pre>
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-slate-400 font-medium">{tr('ops.empty.noCalls.pythonHeading')}</p>
        <pre className="text-[10px] bg-slate-900 border border-slate-800 rounded-lg p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
          {PYTHON_SNIPPET}
        </pre>
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-slate-400 font-medium">{tr('ops.empty.noCalls.typescriptHeading')}</p>
        <pre className="text-[10px] bg-slate-900 border border-slate-800 rounded-lg p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
          {TYPESCRIPT_SNIPPET}
        </pre>
      </div>

      <p className="text-[11px] text-slate-500">{tr('ops.empty.noCalls.naNote')}</p>

      <a
        href={INTEGRATION_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-cyan-400 hover:text-cyan-300 text-[11px] font-medium underline underline-offset-2"
      >
        {tr('ops.empty.noCalls.docsLink')}
      </a>
    </div>
  );
};

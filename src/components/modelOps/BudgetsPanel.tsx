/**
 * Budgets tab (issue #334, sub-issue of #88): lists server-owned budgets and their live state, and lets the
 * user create, edit and delete them.
 *
 * This panel never computes `spent / limit` or classifies a `state` itself: every figure rendered here (name,
 * scope, period, limit, currency, warnAt, enabled, `spent`/`ratio`/`state`/`evaluatedAt`) is read straight from
 * `useBudgetState`'s last good `GET /api/v1/budgets` response (`server/budgets.ts`'s `BudgetView`, via
 * `serverApi.ts`). A progress bar is drawn only when `status.ratio` is not `null`; its width is that `ratio`
 * number formatted as a percentage, not a ratio computed from `spent`/`limit` in the browser. `state` always
 * drives the chip color, even when `spent`/`limit` would imply a different one: see
 * `tests/lib/budgetsPanel.test.tsx`'s contradictory-values test (issue #88's own acceptance criterion).
 *
 * `status === null` on a `BudgetView` (the server computes it exactly when the budget is disabled, or has never
 * been evaluated) renders as a neutral "no state yet" chip, never green/ok. `spent === null` renders as a
 * translated "Unknown" with a tooltip, never `0`. The budget's own `basis` ("reported" vs "reported + estimated")
 * is printed next to every spent figure.
 *
 * Writes go through `useServerApi`'s `ServerApi` (create/update/delete), each refreshing the list via
 * `useBudgetState`'s `refresh()` on success. A create keeps the same `Idempotency-Key` for as long as the form
 * stays open (including across a failed retry), so a double click on Save cannot create a duplicate budget.
 */
import React, { useRef, useState } from 'react';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { useBudgetState } from '../../integrations/useBudgetState';
import {
  BUDGET_BASES,
  BUDGET_PERIODS,
  type BudgetBasis,
  type BudgetPeriod,
  type BudgetScopeType,
  type BudgetState,
  type BudgetInput,
  type BudgetView,
  type ServerApi,
} from '../../integrations/serverApi';
import type { ViewerEvent } from '../../types/agent';
import { Plus, Pencil, Trash2, AlertTriangle, Loader2, ServerCrash } from 'lucide-react';

type MessageParams = Record<string, string | number>;

export interface BudgetsPanelProps {
  locale: Locale;
  /** `null` in demo mode or while the connection/token is still resolving: the panel shows a dedicated message
   * and makes no request (`useBudgetState` already refuses to fetch with a `null` server API). */
  serverApi: ServerApi | null;
  /** Watched for `llm.usage` events to trigger `useBudgetState`'s throttled refresh. */
  events?: ViewerEvent[];
}

// The form only ever offers these three scopes (issue #334's scope); the wider `BUDGET_SCOPE_TYPES` the server
// accepts (`session`/`user`/`tag`) are out of scope here.
const FORM_SCOPE_TYPES: readonly BudgetScopeType[] = ['all', 'agent', 'model'];

interface BudgetFormValues {
  name: string;
  scopeType: BudgetScopeType;
  scopeValue: string;
  period: BudgetPeriod;
  currency: string;
  basis: BudgetBasis;
  limit: string;
  warnAt: string;
  enabled: boolean;
}

const EMPTY_FORM: BudgetFormValues = {
  name: '',
  scopeType: 'all',
  scopeValue: '',
  period: 'month',
  currency: 'USD',
  basis: 'reported',
  limit: '',
  warnAt: '0.8',
  enabled: true,
};

function formValuesFromBudget(budget: BudgetView): BudgetFormValues {
  const scopeType = FORM_SCOPE_TYPES.includes(budget.scope.type) ? budget.scope.type : 'all';
  return {
    name: budget.name,
    scopeType,
    scopeValue: budget.scope.value ?? '',
    period: budget.period,
    currency: budget.currency,
    basis: budget.basis,
    limit: String(budget.limit),
    warnAt: String(budget.warningRatio),
    enabled: budget.enabled,
  };
}

type FormMode = { kind: 'create' } | { kind: 'edit'; id: string };

function stateChipClasses(state: BudgetState | null): string {
  switch (state) {
    case 'ok':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'warning':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'exceeded':
      return 'bg-red-500/20 text-red-300 border-red-500/40';
    case 'unknown':
    case null:
    default:
      // "unknown" and "no state yet" are both neutral: never green/ok, even though an item classified as
      // "unknown" might otherwise look harmless.
      return 'bg-slate-700/40 text-slate-300 border-slate-600/50';
  }
}

function progressBarClasses(state: BudgetState): string {
  switch (state) {
    case 'ok':
      return 'bg-emerald-500';
    case 'warning':
      return 'bg-amber-500';
    case 'exceeded':
      return 'bg-red-500';
    case 'unknown':
    default:
      return 'bg-slate-500';
  }
}

export const BudgetsPanel: React.FC<BudgetsPanelProps> = ({ locale, serverApi, events = [] }) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  // `isOpen: true`: this component is only ever mounted while the Budgets tab is the active tab (see
  // ModelOpsModal.tsx's `{activeTab === 'budgets' && <BudgetsPanel .../>}`), so mounting already is "the tab
  // opened" and unmounting already stops every timer `useBudgetState` owns.
  const budgetState = useBudgetState({ serverApi, isOpen: true, events });

  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [formValues, setFormValues] = useState<BudgetFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string>('');

  const [deleteTarget, setDeleteTarget] = useState<BudgetView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openCreate = () => {
    setFormValues(EMPTY_FORM);
    setFormError(null);
    idempotencyKeyRef.current = crypto.randomUUID();
    setFormMode({ kind: 'create' });
  };

  const openEdit = (budget: BudgetView) => {
    setFormValues(formValuesFromBudget(budget));
    setFormError(null);
    idempotencyKeyRef.current = crypto.randomUUID();
    setFormMode({ kind: 'edit', id: budget.id });
  };

  const closeForm = () => {
    setFormMode(null);
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!serverApi || !formMode || submitting) return;

    const name = formValues.name.trim();
    if (!name) {
      setFormError(tr('ops.budgets.form.error.name'));
      return;
    }
    const limit = Number(formValues.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      setFormError(tr('ops.budgets.form.error.limit'));
      return;
    }
    const warningRatio = Number(formValues.warnAt);
    if (!Number.isFinite(warningRatio) || warningRatio <= 0 || warningRatio >= 1) {
      setFormError(tr('ops.budgets.form.error.warnAt'));
      return;
    }
    const currency = formValues.currency.trim();
    if (!currency) {
      setFormError(tr('ops.budgets.form.error.currency'));
      return;
    }
    const scopeValue = formValues.scopeValue.trim();
    if (formValues.scopeType !== 'all' && !scopeValue) {
      setFormError(tr('ops.budgets.form.error.scopeValue'));
      return;
    }

    setFormError(null);
    setSubmitting(true);

    const input: BudgetInput = {
      name,
      scope: { type: formValues.scopeType, value: formValues.scopeType === 'all' ? null : scopeValue },
      period: formValues.period,
      currency,
      basis: formValues.basis,
      limit,
      warningRatio,
      enabled: formValues.enabled,
    };
    // Same key across every retry of this form session (including one that failed): a double click on Save, or
    // a retry after a dropped response, reuses it so the server never sees it as two separate creates.
    const writeOptions = { idempotencyKey: idempotencyKeyRef.current };

    const result =
      formMode.kind === 'create' ? await serverApi.createBudget(input, writeOptions) : await serverApi.putBudget(formMode.id, input, writeOptions);

    setSubmitting(false);
    if (!result.ok) {
      setFormError(tr('ops.budgets.form.error.submit', { message: result.message ?? result.kind }));
      return;
    }
    setFormMode(null);
    budgetState.refresh();
  };

  const confirmDelete = async () => {
    if (!serverApi || !deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await serverApi.deleteBudget(deleteTarget.id);
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(tr('ops.budgets.delete.error', { message: result.message ?? result.kind }));
      return;
    }
    setDeleteTarget(null);
    budgetState.refresh();
  };

  const renderSpent = (budget: BudgetView) => {
    const basisLabel = tr(`ops.budgets.basis.${budget.basis}` as TranslationKey);
    if (!budget.status) {
      return <span className="italic text-slate-500">{tr('ops.budgets.state.noneYet')}</span>;
    }
    const { spent } = budget.status;
    if (spent === null) {
      return (
        <span>
          <span className="italic text-slate-400" title={tr('ops.budgets.spent.unknownTitle')}>
            {tr('ops.budgets.spent.unknown')}
          </span>
          <span className="block text-[10px] text-slate-500">({basisLabel})</span>
        </span>
      );
    }
    return (
      <span>
        <span className="font-mono text-white">
          {budget.currency} {spent.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span className="block text-[10px] text-slate-500">({basisLabel})</span>
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-white">{tr('ops.budgets.heading')}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{tr('ops.budgets.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {budgetState.asOf !== null && (
            <span className="text-[11px] text-slate-500 font-mono">
              {tr('ops.budgets.asOf', { time: new Date(budgetState.asOf).toLocaleTimeString(locale) })}
            </span>
          )}
          <button
            type="button"
            onClick={openCreate}
            disabled={!serverApi}
            className="px-3 py-1.5 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-[11px] flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{tr('ops.budgets.new')}</span>
          </button>
        </div>
      </div>

      {budgetState.stale && (
        <div role="status" className="flex items-center gap-2 p-2.5 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200 text-[11px]">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{tr('ops.budgets.stale')}</span>
        </div>
      )}

      {!serverApi ? (
        <div className="flex flex-col items-center justify-center gap-2 p-8 text-slate-400 text-xs">
          <ServerCrash className="w-6 h-6" aria-hidden="true" />
          <span>{tr('ops.budgets.requiresLive')}</span>
        </div>
      ) : budgetState.budgets.length > 0 ? (
        <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono">
              <tr>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.name')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.scope')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.period')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.limit')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.warnAt')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.enabled')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.spent')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.state')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.budgets.col.asOf')}</th>
                <th scope="col" className="px-4 py-3 text-right">{tr('ops.budgets.col.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {budgetState.budgets.map((budget) => {
                const status = budget.status;
                const stateLabel = status ? tr(`ops.budgets.state.${status.state}` as TranslationKey) : tr('ops.budgets.state.noneYet');
                const chipClasses = stateChipClasses(status ? status.state : null);
                const scopeLabel = tr(`ops.budgets.scope.${budget.scope.type}` as TranslationKey);

                return (
                  <tr key={budget.id} className="hover:bg-slate-900/50 transition-colors align-top">
                    <td className="px-4 py-3 font-bold text-white">{budget.name}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {scopeLabel}
                      {budget.scope.value && <span className="block text-[10px] text-slate-500 font-mono">{budget.scope.value}</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{tr(`ops.budgets.period.${budget.period}` as TranslationKey)}</td>
                    <td className="px-4 py-3 font-mono text-slate-200">
                      {budget.currency} {budget.limit.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">{Math.round(budget.warningRatio * 100)}%</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                          budget.enabled ? 'bg-sky-500/20 text-sky-300 border-sky-500/40' : 'bg-slate-700/40 text-slate-400 border-slate-600/50'
                        }`}
                      >
                        {tr(budget.enabled ? 'ops.budgets.enabled.yes' : 'ops.budgets.enabled.no')}
                      </span>
                    </td>
                    <td className="px-4 py-3">{renderSpent(budget)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border inline-block ${chipClasses}`}>{stateLabel}</span>
                      {status && status.ratio !== null && (
                        <div
                          role="progressbar"
                          aria-valuenow={Math.round(status.ratio * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden mt-1.5"
                        >
                          <div
                            className={`h-full ${progressBarClasses(status.state)}`}
                            style={{ width: `${Math.min(Math.max(status.ratio, 0), 1) * 100}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400">
                      {status ? new Date(status.evaluatedAt).toLocaleTimeString(locale) : tr('ops.value.na')}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openEdit(budget)}
                        aria-label={`${tr('ops.budgets.edit')} ${budget.name}`}
                        className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-400 hover:text-white border border-slate-800 transition-colors mr-1.5"
                      >
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteTarget(budget);
                          setDeleteError(null);
                        }}
                        aria-label={`${tr('ops.budgets.delete')} ${budget.name}`}
                        className="p-1.5 rounded-lg bg-slate-900 hover:bg-red-950 text-red-400 hover:text-white border border-slate-800 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : budgetState.status === 'error' ? (
        <div className="flex flex-col items-center justify-center gap-2 p-8 text-slate-400 text-xs">
          <ServerCrash className="w-6 h-6" aria-hidden="true" />
          <span>{tr('ops.budgets.loadError')}</span>
          {budgetState.errorMessage && <span className="text-[10px] text-slate-500">{budgetState.errorMessage}</span>}
          <button type="button" onClick={budgetState.refresh} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium">
            {tr('ops.budgets.retry')}
          </button>
        </div>
      ) : budgetState.status === 'ready' ? (
        <p className="text-slate-500 italic text-xs px-1">{tr('ops.budgets.empty')}</p>
      ) : (
        <div className="flex items-center justify-center gap-2 p-8 text-slate-400 text-xs">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span>{tr('ops.budgets.loading')}</span>
        </div>
      )}

      {formMode && (
        <form
          onSubmit={handleSubmit}
          aria-label={formMode.kind === 'create' ? tr('ops.budgets.form.createTitle') : tr('ops.budgets.form.editTitle')}
          className="p-4 rounded-xl bg-slate-900 border border-cyan-500/30 space-y-3"
        >
          <h4 className="text-sm font-bold text-white">{formMode.kind === 'create' ? tr('ops.budgets.form.createTitle') : tr('ops.budgets.form.editTitle')}</h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="av-budgets-name" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.name')}</label>
              <input
                id="av-budgets-name"
                type="text"
                value={formValues.name}
                onChange={(event) => setFormValues((prev) => ({ ...prev, name: event.target.value }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label htmlFor="av-budgets-scope-type" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.scopeType')}</label>
              <select
                id="av-budgets-scope-type"
                value={formValues.scopeType}
                onChange={(event) => setFormValues((prev) => ({ ...prev, scopeType: event.target.value as BudgetScopeType }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                {FORM_SCOPE_TYPES.map((scopeType) => (
                  <option key={scopeType} value={scopeType}>
                    {tr(`ops.budgets.scope.${scopeType}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>

            {formValues.scopeType !== 'all' && (
              <div>
                <label htmlFor="av-budgets-scope-value" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.scopeValue')}</label>
                <input
                  id="av-budgets-scope-value"
                  type="text"
                  placeholder={tr('ops.budgets.form.scopeValuePlaceholder')}
                  value={formValues.scopeValue}
                  onChange={(event) => setFormValues((prev) => ({ ...prev, scopeValue: event.target.value }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>
            )}

            <div>
              <label htmlFor="av-budgets-period" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.period')}</label>
              <select
                id="av-budgets-period"
                value={formValues.period}
                onChange={(event) => setFormValues((prev) => ({ ...prev, period: event.target.value as BudgetPeriod }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                {BUDGET_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {tr(`ops.budgets.period.${period}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="av-budgets-limit" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.limit')}</label>
              <input
                id="av-budgets-limit"
                type="number"
                min="0"
                step="0.01"
                value={formValues.limit}
                onChange={(event) => setFormValues((prev) => ({ ...prev, limit: event.target.value }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label htmlFor="av-budgets-currency" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.currency')}</label>
              <input
                id="av-budgets-currency"
                type="text"
                value={formValues.currency}
                onChange={(event) => setFormValues((prev) => ({ ...prev, currency: event.target.value.toUpperCase() }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label htmlFor="av-budgets-warnAt" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.warnAt')}</label>
              <input
                id="av-budgets-warnAt"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={formValues.warnAt}
                onChange={(event) => setFormValues((prev) => ({ ...prev, warnAt: event.target.value }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label htmlFor="av-budgets-basis" className="text-[11px] text-slate-300 font-medium block mb-1">{tr('ops.budgets.form.costBasis')}</label>
              <select
                id="av-budgets-basis"
                value={formValues.basis}
                onChange={(event) => setFormValues((prev) => ({ ...prev, basis: event.target.value as BudgetBasis }))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                {BUDGET_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {tr(`ops.budgets.basis.${basis}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>

            <label htmlFor="av-budgets-enabled" className="flex items-center gap-2 cursor-pointer">
              <input
                id="av-budgets-enabled"
                type="checkbox"
                checked={formValues.enabled}
                onChange={(event) => setFormValues((prev) => ({ ...prev, enabled: event.target.checked }))}
                className="rounded border-slate-700 text-cyan-600 focus:ring-0 w-4 h-4"
              />
              <span className="text-[11px] text-slate-300 font-medium">{tr('ops.budgets.form.enabled')}</span>
            </label>
          </div>

          {formError && (
            <p role="alert" className="text-red-400 text-[11px]">
              {formError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeForm}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium disabled:opacity-50"
            >
              {tr('ops.budgets.form.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-[11px] font-bold disabled:opacity-50"
            >
              {submitting ? tr('ops.budgets.form.saving') : tr('ops.budgets.form.save')}
            </button>
          </div>
        </form>
      )}

      {deleteTarget && (
        <div role="alertdialog" aria-label={tr('ops.budgets.delete.confirmTitle', { name: deleteTarget.name })} className="p-4 rounded-xl bg-red-950/40 border border-red-500/40 space-y-3">
          <p className="text-sm font-bold text-white">{tr('ops.budgets.delete.confirmTitle', { name: deleteTarget.name })}</p>
          <p className="text-[11px] text-slate-300">{tr('ops.budgets.delete.confirmBody')}</p>
          {deleteError && (
            <p role="alert" className="text-red-400 text-[11px]">
              {deleteError}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              disabled={deleting}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium disabled:opacity-50"
            >
              {tr('ops.budgets.delete.cancel')}
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deleting}
              className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-[11px] font-bold disabled:opacity-50"
            >
              {tr('ops.budgets.delete.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

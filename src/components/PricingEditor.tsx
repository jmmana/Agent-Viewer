/**
 * Server pricing editor (issue #333, sub-issue of #88): the only place in the portal that reads or writes the
 * server's pricing catalog (`GET /api/v1/pricing`, `POST /api/v1/pricing/changes`, `GET /api/v1/pricing/versions
 * [/:version/diff]`, all via `ServerApi`, see `src/integrations/serverApi.ts`). Mounted both as the Model Ops
 * "pricing" tab (`ModelOpsModal.tsx`) and inside `SettingsModal.tsx`; both callers resolve their own
 * `ServerApi | null` (via `useServerApi`) and pass it in, so this component never resolves a connection itself.
 *
 * `serverApi === null` is demo mode (issue #333 section "Modo demo"): no request is ever made and nothing is
 * editable, only a short explanation is shown. This mirrors `useModelOpsLedger`'s `ledger === null` convention.
 *
 * A price is `number | null`, never a bare `0` standing in for "unknown": an emptied input saves `null` ("sin
 * precio"), a deliberately typed `0` saves and displays as `0`. The parser is strict (`parsePriceInput` below),
 * never `parseFloat(...) || 0`. Every row's editable state (`RowDraft.draft`) is a deep copy of the server's
 * entry (`clonePriceEntry`), never the response object itself, so typing in the grid can never mutate what
 * `getPricing()` returned (`tests/lib/pricingEditor.test.tsx` checks this directly).
 *
 * Optimistic concurrency: every write carries `expectedVersion`, and a successful write's own
 * `PricingChangesResult.pricingVersion` becomes the `expectedVersion` for the *next* write (tracked in
 * `currentVersionRef`, read synchronously so two sequential saves never race on stale React state). A `409
 * version_conflict` never discards what the operator typed: the row's `draft` is left untouched, only its
 * status flips to `conflict` with a "Reapply" action that retries the same upsert against the server's
 * `currentVersion` from the 409 body.
 *
 * `effectiveFrom` is part of a `PriceEntry`'s natural key (`provider`, `model`, `kind`, `effectiveFrom`), so
 * changing it for an existing row is really "remove the old key, upsert the new one": `saveRow` detects this
 * and sends both `removals` and `upserts` in the same `POST /pricing/changes` call.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Locale, type TranslationKey } from '../i18n';
import type {
  ServerApi,
  PricingSnapshotResponse,
  PricingVersionSummary,
  PricingVersionDiffResponse,
} from '../integrations/serverApi';
import {
  priceEntryNaturalKey,
  type PriceEntry,
  type PriceEntryInput,
  type PriceEntryKey,
  type PriceKind,
  type ReasoningBilling,
} from '../integrations/pricingContract';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  DollarSign,
  History,
  Loader2,
  Lock,
  Plus,
  RotateCw,
  ServerCrash,
  X,
} from 'lucide-react';

type MessageParams = Record<string, string | number>;

export interface PricingEditorProps {
  /** `null` is demo mode: no request is ever made, nothing is editable. */
  serverApi: ServerApi | null;
  locale: Locale;
}

// -------------------------------------------------------------
// Editable price fields: number | null, never a default-to-0 fallback.
// -------------------------------------------------------------

const PRICE_FIELD_NAMES = [
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
  'reasoningPerMillion',
] as const;
type PriceFieldName = (typeof PRICE_FIELD_NAMES)[number];

const PRICE_FIELD_COL_KEY: Record<PriceFieldName, TranslationKey> = {
  inputPerMillion: 'ops.pricing.col.input',
  outputPerMillion: 'ops.pricing.col.output',
  cacheReadPerMillion: 'ops.pricing.col.cacheRead',
  cacheWritePerMillion: 'ops.pricing.col.cacheWrite',
  reasoningPerMillion: 'ops.pricing.col.reasoning',
};

const PRICE_FIELD_ARIA_KEY: Record<PriceFieldName, TranslationKey> = {
  inputPerMillion: 'ops.pricing.aria.input',
  outputPerMillion: 'ops.pricing.aria.output',
  cacheReadPerMillion: 'ops.pricing.aria.cacheRead',
  cacheWritePerMillion: 'ops.pricing.aria.cacheWrite',
  reasoningPerMillion: 'ops.pricing.aria.reasoning',
};

/** Mirrors `pricingContract.ts`'s own bound (`MAX_PRICE_VALUE`), kept local since that constant is not exported. */
const MAX_PRICE_VALUE = 1_000_000;

/** A plain non-negative decimal: no scientific notation, no thousands separators, no leading `+`/`-`. */
const PLAIN_NUMBER_PATTERN = /^\d+(\.\d+)?$/;

type ParsedPrice = { ok: true; value: number | null } | { ok: false };

/**
 * Strict parser: empty (after trim) is `null` ("sin precio"), a plain non-negative number within bounds is
 * itself (including `0`), anything else is rejected. Never `parseFloat(...) || 0`: a typed `0` and an emptied
 * field are never confused.
 */
function parsePriceInput(raw: string): ParsedPrice {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!PLAIN_NUMBER_PATTERN.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value > MAX_PRICE_VALUE) return { ok: false };
  return { ok: true, value };
}

function clonePriceEntry(entry: PriceEntry): PriceEntry {
  return { ...entry, aliases: [...entry.aliases] };
}

function rawInputsFromEntry(entry: PriceEntry): Record<PriceFieldName, string> {
  const out = {} as Record<PriceFieldName, string>;
  for (const field of PRICE_FIELD_NAMES) {
    const value = entry[field];
    out[field] = value === null ? '' : String(value);
  }
  return out;
}

function toPriceEntryInput(entry: PriceEntry): PriceEntryInput {
  return {
    provider: entry.provider,
    model: entry.model,
    aliases: entry.aliases,
    kind: entry.kind,
    currency: entry.currency,
    effectiveFrom: entry.effectiveFrom,
    inputPerMillion: entry.inputPerMillion,
    outputPerMillion: entry.outputPerMillion,
    cacheReadPerMillion: entry.cacheReadPerMillion,
    cacheWritePerMillion: entry.cacheWritePerMillion,
    reasoningPerMillion: entry.reasoningPerMillion,
    reasoningBilling: entry.reasoningBilling,
    estimated: entry.estimated,
    sourceUrl: entry.sourceUrl,
    sourceCheckedAt: entry.sourceCheckedAt,
    note: entry.note,
  };
}

function toRemovalKey(entry: PriceEntry): PriceEntryKey {
  return { provider: entry.provider, model: entry.model, kind: entry.kind, effectiveFrom: entry.effectiveFrom };
}

function entryKey(entry: Pick<PriceEntry, 'provider' | 'model' | 'kind' | 'effectiveFrom'>): string {
  return priceEntryNaturalKey(entry);
}

// -------------------------------------------------------------
// Row editing state
// -------------------------------------------------------------

type FieldErrorKey = PriceFieldName | 'currency' | 'effectiveFrom';

interface RowDraft {
  key: string;
  /** Deep copy of the last known-good server entry: the dirty-check baseline and the "reset" target. */
  original: PriceEntry;
  /** Deep copy the user edits; never the response object (never shared with `original` or the server response). */
  draft: PriceEntry;
  rawInputs: Record<PriceFieldName, string>;
  currencyRaw: string;
  /** `YYYY-MM-DD`, drives `draft.effectiveFrom` (normalized to UTC midnight on change). */
  effectiveFromDate: string;
  fieldErrors: Partial<Record<FieldErrorKey, true>>;
  status: 'idle' | 'saving' | 'conflict';
  saveError: string | null;
  conflictVersion: number | null;
}

function freshRow(entry: PriceEntry): RowDraft {
  return {
    key: entryKey(entry),
    original: clonePriceEntry(entry),
    draft: clonePriceEntry(entry),
    rawInputs: rawInputsFromEntry(entry),
    currencyRaw: entry.currency,
    effectiveFromDate: entry.effectiveFrom.slice(0, 10),
    fieldErrors: {},
    status: 'idle',
    saveError: null,
    conflictVersion: null,
  };
}

function isRowDirty(row: RowDraft): boolean {
  return JSON.stringify(row.draft) !== JSON.stringify(row.original);
}

function rowHasFieldErrors(row: RowDraft): boolean {
  return Object.keys(row.fieldErrors).length > 0;
}

function rowAllPricesNull(row: RowDraft): boolean {
  return PRICE_FIELD_NAMES.every((field) => row.draft[field] === null);
}

// -------------------------------------------------------------
// Add-model form state
// -------------------------------------------------------------

interface NewModelDraft {
  provider: string;
  model: string;
  kind: PriceKind;
  currency: string;
  effectiveFromDate: string;
  rawInputs: Record<PriceFieldName, string>;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankNewModelDraft(): NewModelDraft {
  return {
    provider: '',
    model: '',
    kind: 'list',
    currency: 'USD',
    effectiveFromDate: todayDateString(),
    rawInputs: { inputPerMillion: '', outputPerMillion: '', cacheReadPerMillion: '', cacheWritePerMillion: '', reasoningPerMillion: '' },
  };
}

// -------------------------------------------------------------
// Fetch state (issue #333: "carga, vacío, error, solo lectura (403), actualiza el servidor (404)")
// -------------------------------------------------------------

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; data: PricingSnapshotResponse }
  | { status: 'unavailable' }
  | { status: 'forbidden' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; versions: PricingVersionSummary[] }
  | { status: 'error' };

type DiffState = { status: 'loading' } | { status: 'ready'; diff: PricingVersionDiffResponse } | { status: 'error' };

function reasonFor(action: string, provider: string, model: string): string {
  return `Agent Viewer pricing editor: ${action} ${provider}/${model}`;
}

export const PricingEditor: React.FC<PricingEditorProps> = ({ serverApi, locale }) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  const [rows, setRows] = useState<Map<string, RowDraft>>(new Map());
  const [writeForbidden, setWriteForbidden] = useState(false);
  const currentVersionRef = useRef<number | null>(null);

  const [showAddModel, setShowAddModel] = useState(false);
  const [newModel, setNewModel] = useState<NewModelDraft>(blankNewModelDraft);
  const [newModelErrors, setNewModelErrors] = useState<Partial<Record<FieldErrorKey | 'provider' | 'model', true>>>({});
  const [newModelSaveError, setNewModelSaveError] = useState<string | null>(null);
  const [newModelSubmitting, setNewModelSubmitting] = useState(false);

  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });
  const [diffs, setDiffs] = useState<Map<number, DiffState>>(new Map());
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  const requestIdRef = useRef(0);

  const setVersion = (version: number) => {
    currentVersionRef.current = version;
  };

  const load = useCallback(() => {
    if (!serverApi) return;
    const requestId = ++requestIdRef.current;
    setFetchState({ status: 'loading' });
    void (async () => {
      const result = await serverApi.getPricing();
      if (requestIdRef.current !== requestId) return;
      if (!result.ok) {
        if (result.kind === 'not_found') {
          setFetchState({ status: 'unavailable' });
        } else if (result.kind === 'forbidden') {
          setFetchState({ status: 'forbidden' });
        } else if (result.kind === 'unauthorized') {
          setFetchState({ status: 'unauthorized' });
        } else {
          setFetchState({ status: 'error', message: result.message ?? result.kind });
        }
        return;
      }
      setVersion(result.data.pricingVersion ?? 0);
      setRows((prev) => {
        const next = new Map<string, RowDraft>();
        for (const entry of result.data.entries) {
          const key = entryKey(entry);
          const existing = prev.get(key);
          // A row mid-save/dirty/conflict keeps its typed values: a refetch (initial load or manual retry) never
          // clobbers an operator's unsaved edits.
          if (existing && (existing.status !== 'idle' || isRowDirty(existing))) {
            next.set(key, existing);
          } else {
            next.set(key, freshRow(entry));
          }
        }
        return next;
      });
      setFetchState({ status: 'ready', data: result.data });
    })();
  }, [serverApi]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Row field editing -------------------------------------------------

  const updateRow = (key: string, updater: (row: RowDraft) => RowDraft) => {
    setRows((prev) => {
      const row = prev.get(key);
      if (!row) return prev;
      const next = new Map(prev);
      next.set(key, updater(row));
      return next;
    });
  };

  const handlePriceFieldChange = (key: string, field: PriceFieldName, raw: string) => {
    const parsed = parsePriceInput(raw);
    updateRow(key, (row) => {
      const draft = { ...row.draft };
      const fieldErrors = { ...row.fieldErrors };
      if (parsed.ok) {
        draft[field] = parsed.value;
        delete fieldErrors[field];
        if (field === 'reasoningPerMillion') {
          const nextBilling: ReasoningBilling | null = parsed.value === null ? null : (draft.reasoningBilling ?? 'separate');
          draft.reasoningBilling = nextBilling;
        }
      } else {
        fieldErrors[field] = true;
      }
      return {
        ...row,
        draft,
        rawInputs: { ...row.rawInputs, [field]: raw },
        fieldErrors,
        saveError: null,
        status: row.status === 'conflict' ? 'idle' : row.status,
        conflictVersion: row.status === 'conflict' ? null : row.conflictVersion,
      };
    });
  };

  const handleCurrencyChange = (key: string, raw: string) => {
    const upper = raw.toUpperCase().slice(0, 3);
    const valid = /^[A-Z]{3}$/.test(upper);
    updateRow(key, (row) => {
      const fieldErrors = { ...row.fieldErrors };
      if (valid) delete fieldErrors.currency;
      else fieldErrors.currency = true;
      return {
        ...row,
        draft: valid ? { ...row.draft, currency: upper } : row.draft,
        currencyRaw: upper,
        fieldErrors,
        saveError: null,
        status: row.status === 'conflict' ? 'idle' : row.status,
        conflictVersion: row.status === 'conflict' ? null : row.conflictVersion,
      };
    });
  };

  const handleEffectiveFromChange = (key: string, raw: string) => {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));
    updateRow(key, (row) => {
      const fieldErrors = { ...row.fieldErrors };
      if (valid) delete fieldErrors.effectiveFrom;
      else fieldErrors.effectiveFrom = true;
      return {
        ...row,
        draft: valid ? { ...row.draft, effectiveFrom: `${raw}T00:00:00.000Z` } : row.draft,
        effectiveFromDate: raw,
        fieldErrors,
        saveError: null,
        status: row.status === 'conflict' ? 'idle' : row.status,
        conflictVersion: row.status === 'conflict' ? null : row.conflictVersion,
      };
    });
  };

  // --- Save ---------------------------------------------------------------

  const saveRow = async (key: string) => {
    if (!serverApi) return;
    const row = rows.get(key);
    if (!row) return;
    if (rowHasFieldErrors(row)) {
      updateRow(key, (r) => ({ ...r, saveError: tr('ops.pricing.validation.price') }));
      return;
    }
    if (rowAllPricesNull(row)) {
      updateRow(key, (r) => ({ ...r, saveError: tr('ops.pricing.validation.allNull') }));
      return;
    }
    if (currentVersionRef.current === null) return;

    updateRow(key, (r) => ({ ...r, status: 'saving', saveError: null }));

    const newKey = entryKey(row.draft);
    const removals: PriceEntryKey[] = newKey !== key ? [toRemovalKey(row.original)] : [];
    const reason = reasonFor('updated', row.draft.provider, row.draft.model);

    const result = await serverApi.putPricingChanges({
      expectedVersion: currentVersionRef.current,
      reason,
      upserts: [toPriceEntryInput(row.draft)],
      removals,
    });

    if (result.ok) {
      setVersion(result.data.pricingVersion);
      const committed = clonePriceEntry(row.draft);
      setRows((prev) => {
        const next = new Map(prev);
        next.delete(key);
        next.set(newKey, freshRow(committed));
        return next;
      });
      return;
    }

    if (result.kind === 'conflict') {
      updateRow(key, (r) => ({
        ...r,
        status: 'conflict',
        conflictVersion: result.currentVersion ?? null,
        saveError: tr('ops.pricing.conflict', { version: result.currentVersion ?? '?' }),
      }));
      return;
    }

    if (result.kind === 'forbidden') {
      setWriteForbidden(true);
      updateRow(key, (r) => ({ ...r, status: 'idle', saveError: tr('ops.pricing.forbidden') }));
      return;
    }

    updateRow(key, (r) => ({ ...r, status: 'idle', saveError: result.message ?? result.kind }));
  };

  const reapplyRow = async (key: string) => {
    const row = rows.get(key);
    if (row?.conflictVersion != null) setVersion(row.conflictVersion);
    await saveRow(key);
  };

  // --- Add model ------------------------------------------------------------

  const handleNewModelPriceChange = (field: PriceFieldName, raw: string) => {
    setNewModel((prev) => ({ ...prev, rawInputs: { ...prev.rawInputs, [field]: raw } }));
    setNewModelErrors((prev) => {
      const next = { ...prev };
      if (parsePriceInput(raw).ok) delete next[field];
      else next[field] = true;
      return next;
    });
    setNewModelSaveError(null);
  };

  const submitNewModel = async () => {
    if (!serverApi) return;
    const provider = newModel.provider.trim().toLowerCase();
    const model = newModel.model.trim().toLowerCase();
    const currencyValid = /^[A-Z]{3}$/.test(newModel.currency);
    const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(newModel.effectiveFromDate) && !Number.isNaN(Date.parse(`${newModel.effectiveFromDate}T00:00:00Z`));

    const parsedPrices: Partial<Record<PriceFieldName, number | null>> = {};
    const errors: Partial<Record<FieldErrorKey | 'provider' | 'model', true>> = {};
    for (const field of PRICE_FIELD_NAMES) {
      const parsed = parsePriceInput(newModel.rawInputs[field]);
      if (parsed.ok) parsedPrices[field] = parsed.value;
      else errors[field] = true;
    }
    if (!provider) errors.provider = true;
    if (!model) errors.model = true;
    if (!currencyValid) errors.currency = true;
    if (!dateValid) errors.effectiveFrom = true;

    const allNull = PRICE_FIELD_NAMES.every((field) => (parsedPrices[field] ?? null) === null);
    setNewModelErrors(errors);
    if (Object.keys(errors).length > 0) {
      setNewModelSaveError(tr('ops.pricing.validation.identity'));
      return;
    }
    if (allNull) {
      setNewModelSaveError(tr('ops.pricing.validation.allNull'));
      return;
    }
    if (currentVersionRef.current === null) return;

    setNewModelSubmitting(true);
    setNewModelSaveError(null);

    const input: PriceEntryInput = {
      provider,
      model,
      aliases: [],
      kind: newModel.kind,
      currency: newModel.currency,
      effectiveFrom: `${newModel.effectiveFromDate}T00:00:00.000Z`,
      inputPerMillion: parsedPrices.inputPerMillion ?? null,
      outputPerMillion: parsedPrices.outputPerMillion ?? null,
      cacheReadPerMillion: parsedPrices.cacheReadPerMillion ?? null,
      cacheWritePerMillion: parsedPrices.cacheWritePerMillion ?? null,
      reasoningPerMillion: parsedPrices.reasoningPerMillion ?? null,
      reasoningBilling: parsedPrices.reasoningPerMillion ? 'separate' : null,
      estimated: false,
      sourceUrl: null,
      sourceCheckedAt: null,
      note: null,
    };

    const result = await serverApi.putPricingChanges({
      expectedVersion: currentVersionRef.current,
      reason: reasonFor('added', provider, model),
      upserts: [input],
    });

    setNewModelSubmitting(false);

    if (result.ok) {
      setVersion(result.data.pricingVersion);
      const committed: PriceEntry = {
        provider,
        model,
        aliases: [],
        kind: newModel.kind,
        currency: newModel.currency,
        effectiveFrom: `${newModel.effectiveFromDate}T00:00:00.000Z`,
        inputPerMillion: parsedPrices.inputPerMillion ?? null,
        outputPerMillion: parsedPrices.outputPerMillion ?? null,
        cacheReadPerMillion: parsedPrices.cacheReadPerMillion ?? null,
        cacheWritePerMillion: parsedPrices.cacheWritePerMillion ?? null,
        reasoningPerMillion: parsedPrices.reasoningPerMillion ?? null,
        reasoningBilling: parsedPrices.reasoningPerMillion ? 'separate' : null,
        source: 'api',
        estimated: false,
        sourceUrl: null,
        sourceCheckedAt: null,
        note: null,
      };
      setRows((prev) => {
        const next = new Map(prev);
        next.set(entryKey(committed), freshRow(committed));
        return next;
      });
      setNewModel(blankNewModelDraft());
      setShowAddModel(false);
      return;
    }

    if (result.kind === 'conflict') {
      if (result.currentVersion !== undefined) setVersion(result.currentVersion);
      setNewModelSaveError(tr('ops.pricing.conflict', { version: result.currentVersion ?? '?' }));
      return;
    }
    if (result.kind === 'forbidden') {
      setWriteForbidden(true);
      setNewModelSaveError(tr('ops.pricing.forbidden'));
      return;
    }
    setNewModelSaveError(result.message ?? result.kind);
  };

  // --- History drawer -------------------------------------------------------

  const loadHistory = () => {
    if (!serverApi) return;
    setHistory({ status: 'loading' });
    void (async () => {
      const result = await serverApi.getPricingVersions({ limit: 20 });
      if (!result.ok) {
        setHistory({ status: 'error' });
        return;
      }
      setHistory({ status: 'ready', versions: result.data.versions });
    })();
  };

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history.status === 'idle') loadHistory();
  };

  const toggleDiff = (version: number) => {
    if (expandedVersion === version) {
      setExpandedVersion(null);
      return;
    }
    setExpandedVersion(version);
    if (!serverApi || currentVersionRef.current === null || diffs.has(version)) return;
    setDiffs((prev) => new Map(prev).set(version, { status: 'loading' }));
    void (async () => {
      const result = await serverApi.getPricingVersionDiff(version, currentVersionRef.current as number);
      setDiffs((prev) => {
        const next = new Map(prev);
        next.set(version, result.ok ? { status: 'ready', diff: result.data } : { status: 'error' });
        return next;
      });
    })();
  };

  // --- Rendering --------------------------------------------------------

  if (!serverApi) {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 space-y-1.5">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          <span>{tr('ops.pricing.demo.heading')}</span>
        </h3>
        <p className="text-xs text-slate-400">{tr('ops.pricing.demo.body')}</p>
      </div>
    );
  }

  const readOnlyStore = fetchState.status === 'ready' && fetchState.data.readonly;
  const effectiveReadOnly = writeForbidden || readOnlyStore;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            <span>{tr('ops.pricing.heading')}</span>
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{tr('ops.pricing.subtitle')}</p>
          {fetchState.status === 'ready' && (
            <p className="text-[11px] text-slate-500 font-mono mt-0.5">
              {tr('ops.pricing.versionLabel', { version: fetchState.data.pricingVersion ?? 0, count: fetchState.data.entries.length })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={toggleHistory}
          aria-expanded={showHistory}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 text-xs font-medium transition-colors"
        >
          <History className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{tr('ops.pricing.history.toggle')}</span>
        </button>
      </div>

      {writeForbidden && (
        <div role="status" className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/50 text-amber-200 flex items-start gap-2 text-xs">
          <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.pricing.forbidden')}</span>
        </div>
      )}
      {!writeForbidden && readOnlyStore && (
        <div role="status" className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/50 text-amber-200 flex items-start gap-2 text-xs">
          <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.pricing.readonlyStore')}</span>
        </div>
      )}
      {fetchState.status === 'ready' && fetchState.data.issues.length > 0 && (
        <div role="status" className="p-3 rounded-xl bg-rose-950/40 border border-rose-900/50 text-rose-200 flex items-start gap-2 text-xs">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.pricing.fileIssues', { issues: fetchState.data.issues.map((issue) => issue.message).join('; ') })}</span>
        </div>
      )}

      {fetchState.status === 'loading' && (
        <div role="status" aria-busy="true" className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2 text-slate-400 text-xs">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" aria-hidden="true" />
          <span>{tr('ops.pricing.loading')}</span>
        </div>
      )}

      {fetchState.status === 'unavailable' && (
        <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
          <ServerCrash className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.pricing.unavailable')}</span>
        </div>
      )}

      {fetchState.status === 'forbidden' && (
        <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
          <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.pricing.forbidden')}</span>
        </div>
      )}

      {fetchState.status === 'unauthorized' && (
        <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
          <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{tr('ops.empty.unauthorized')}</span>
        </div>
      )}

      {fetchState.status === 'error' && (
        <div role="status" className="p-4 rounded-xl bg-slate-950 border border-red-900/60 text-slate-300 space-y-2 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {tr('ops.empty.networkError')} {fetchState.message}
            </span>
          </div>
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium border border-slate-700/60 transition-colors"
          >
            {tr('ops.empty.retry')}
          </button>
        </div>
      )}

      {fetchState.status === 'ready' && (
        <>
          {rows.size === 0 ? (
            <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 text-center text-xs">
              {tr('ops.pricing.empty')}
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] text-slate-400 bg-slate-900/40">
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.provider')}</th>
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.model')}</th>
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.currency')}</th>
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.effectiveFrom')}</th>
                    {PRICE_FIELD_NAMES.map((field) => (
                      <th key={field} scope="col" className="py-2.5 px-3 text-right">{tr(PRICE_FIELD_COL_KEY[field])}</th>
                    ))}
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.origin')}</th>
                    <th scope="col" className="py-2.5 px-3">{tr('ops.pricing.col.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {[...rows.values()].map((row) => {
                    const dirty = isRowDirty(row);
                    const disabled = effectiveReadOnly || row.status === 'saving';
                    return (
                      <tr key={row.key} className="hover:bg-slate-900/30 align-top">
                        <td className="py-2 px-3 text-slate-400 font-sans">{row.draft.provider}</td>
                        <td className="py-2 px-3 font-semibold text-slate-200">
                          {row.draft.model}
                          {row.draft.estimated && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40">
                              {tr('ops.pricing.estimatedBadge')}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={row.currencyRaw}
                            maxLength={3}
                            disabled={disabled}
                            aria-label={tr('ops.pricing.aria.currency', { model: row.draft.model })}
                            aria-invalid={Boolean(row.fieldErrors.currency)}
                            onChange={(e) => handleCurrencyChange(row.key, e.target.value)}
                            className={`w-14 uppercase bg-slate-900 border rounded px-1.5 py-0.5 text-slate-200 text-xs focus:outline-none disabled:opacity-50 ${row.fieldErrors.currency ? 'border-rose-700' : 'border-slate-800'}`}
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="date"
                            value={row.effectiveFromDate}
                            disabled={disabled}
                            aria-label={tr('ops.pricing.aria.effectiveFrom', { model: row.draft.model })}
                            aria-invalid={Boolean(row.fieldErrors.effectiveFrom)}
                            onChange={(e) => handleEffectiveFromChange(row.key, e.target.value)}
                            className={`bg-slate-900 border rounded px-1.5 py-0.5 text-slate-200 text-xs focus:outline-none disabled:opacity-50 ${row.fieldErrors.effectiveFrom ? 'border-rose-700' : 'border-slate-800'}`}
                          />
                        </td>
                        {PRICE_FIELD_NAMES.map((field) => (
                          <td key={field} className="py-2 px-3 text-right">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={row.rawInputs[field]}
                              placeholder={tr('ops.pricing.notPriced')}
                              disabled={disabled}
                              aria-label={tr(PRICE_FIELD_ARIA_KEY[field], { model: row.draft.model })}
                              aria-invalid={Boolean(row.fieldErrors[field])}
                              onChange={(e) => handlePriceFieldChange(row.key, field, e.target.value)}
                              className={`w-20 bg-slate-900 border rounded px-1.5 py-0.5 text-right text-emerald-400 text-xs focus:outline-none disabled:opacity-50 ${row.fieldErrors[field] ? 'border-rose-700' : 'border-slate-800'}`}
                            />
                          </td>
                        ))}
                        <td className="py-2 px-3 text-slate-400">
                          <span>{tr(`ops.pricing.origin.${row.original.source}` as TranslationKey)}</span>
                        </td>
                        <td className="py-2 px-3 space-y-1.5">
                          <button
                            type="button"
                            onClick={() => saveRow(row.key)}
                            disabled={!dirty || disabled}
                            aria-label={tr('ops.pricing.aria.save', { model: row.draft.model })}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white text-[11px] font-semibold transition-colors"
                          >
                            {row.status === 'saving' ? (
                              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                            ) : (
                              <Check className="w-3 h-3" aria-hidden="true" />
                            )}
                            <span>{row.status === 'saving' ? tr('ops.pricing.saving') : tr('ops.pricing.save')}</span>
                          </button>
                          {row.status === 'conflict' && (
                            <div role="alert" className="text-[10px] text-amber-300 space-y-1">
                              <p>{row.saveError}</p>
                              <button
                                type="button"
                                onClick={() => reapplyRow(row.key)}
                                className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-900/50 hover:bg-amber-900/70 text-amber-200 border border-amber-800/60"
                              >
                                <RotateCw className="w-3 h-3" aria-hidden="true" />
                                <span>{tr('ops.pricing.reapply')}</span>
                              </button>
                            </div>
                          )}
                          {row.status !== 'conflict' && row.saveError && (
                            <p role="alert" className="text-[10px] text-rose-400">{row.saveError}</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Add-model form */}
          <div className="border border-slate-800 rounded-xl bg-slate-950 p-3.5 space-y-3">
            <button
              type="button"
              onClick={() => setShowAddModel((v) => !v)}
              disabled={effectiveReadOnly}
              className="flex items-center gap-1.5 text-xs font-semibold text-sky-300 hover:text-sky-200 disabled:opacity-40"
            >
              {showAddModel ? <X className="w-3.5 h-3.5" aria-hidden="true" /> : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{showAddModel ? tr('ops.pricing.addModel.cancel') : tr('ops.pricing.addModel.toggle')}</span>
            </button>

            {showAddModel && (
              <div className="space-y-3 text-xs">
                <h4 className="font-bold text-white">{tr('ops.pricing.addModel.heading')}</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="block text-[10px] text-slate-400">{tr('ops.pricing.addModel.providerLabel')}</span>
                    <input
                      type="text"
                      value={newModel.provider}
                      onChange={(e) => setNewModel((p) => ({ ...p, provider: e.target.value }))}
                      aria-invalid={Boolean(newModelErrors.provider)}
                      className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-slate-200 focus:outline-none ${newModelErrors.provider ? 'border-rose-700' : 'border-slate-800'}`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[10px] text-slate-400">{tr('ops.pricing.addModel.modelLabel')}</span>
                    <input
                      type="text"
                      value={newModel.model}
                      onChange={(e) => setNewModel((p) => ({ ...p, model: e.target.value }))}
                      aria-invalid={Boolean(newModelErrors.model)}
                      className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-slate-200 focus:outline-none ${newModelErrors.model ? 'border-rose-700' : 'border-slate-800'}`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[10px] text-slate-400">{tr('ops.pricing.addModel.kindLabel')}</span>
                    <select
                      value={newModel.kind}
                      onChange={(e) => setNewModel((p) => ({ ...p, kind: e.target.value as PriceKind }))}
                      className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
                    >
                      <option value="list">{tr('ops.pricing.addModel.kind.list')}</option>
                      <option value="override">{tr('ops.pricing.addModel.kind.override')}</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[10px] text-slate-400">{tr('ops.pricing.addModel.currencyLabel')}</span>
                    <input
                      type="text"
                      maxLength={3}
                      value={newModel.currency}
                      onChange={(e) => setNewModel((p) => ({ ...p, currency: e.target.value.toUpperCase().slice(0, 3) }))}
                      aria-invalid={Boolean(newModelErrors.currency)}
                      className={`w-full uppercase bg-slate-900 border rounded px-1.5 py-1 text-slate-200 focus:outline-none ${newModelErrors.currency ? 'border-rose-700' : 'border-slate-800'}`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[10px] text-slate-400">{tr('ops.pricing.addModel.effectiveFromLabel')}</span>
                    <input
                      type="date"
                      value={newModel.effectiveFromDate}
                      onChange={(e) => setNewModel((p) => ({ ...p, effectiveFromDate: e.target.value }))}
                      aria-invalid={Boolean(newModelErrors.effectiveFrom)}
                      className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-slate-200 focus:outline-none ${newModelErrors.effectiveFrom ? 'border-rose-700' : 'border-slate-800'}`}
                    />
                  </label>
                  {PRICE_FIELD_NAMES.map((field) => (
                    <label key={field} className="space-y-1">
                      <span className="block text-[10px] text-slate-400">{tr(PRICE_FIELD_COL_KEY[field])}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={tr('ops.pricing.notPriced')}
                        value={newModel.rawInputs[field]}
                        onChange={(e) => handleNewModelPriceChange(field, e.target.value)}
                        aria-invalid={Boolean(newModelErrors[field])}
                        className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-right text-emerald-400 focus:outline-none ${newModelErrors[field] ? 'border-rose-700' : 'border-slate-800'}`}
                      />
                    </label>
                  ))}
                </div>
                {newModelSaveError && <p role="alert" className="text-[11px] text-rose-400">{newModelSaveError}</p>}
                <button
                  type="button"
                  onClick={submitNewModel}
                  disabled={newModelSubmitting || effectiveReadOnly}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                >
                  {newModelSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                  <span>{tr('ops.pricing.addModel.submit')}</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* History drawer */}
      {showHistory && (
        <div className="border border-slate-800 rounded-xl bg-slate-950 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <History className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <span>{tr('ops.pricing.history.heading')}</span>
            </h4>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              aria-label={tr('ops.pricing.history.close')}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {history.status === 'loading' && (
            <div role="status" className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" aria-hidden="true" />
              <span>{tr('ops.pricing.history.loading')}</span>
            </div>
          )}
          {history.status === 'error' && <p role="status" className="text-xs text-rose-400">{tr('ops.pricing.history.error')}</p>}
          {history.status === 'ready' && history.versions.length === 0 && (
            <p role="status" className="text-xs text-slate-400">{tr('ops.pricing.history.empty')}</p>
          )}
          {history.status === 'ready' && history.versions.length > 0 && (
            <ul className="space-y-2 text-xs">
              {history.versions.map((version) => {
                const diff = diffs.get(version.pricingVersion);
                const expanded = expandedVersion === version.pricingVersion;
                return (
                  <li key={version.pricingVersion} className="border border-slate-800 rounded-lg bg-slate-900/60">
                    <button
                      type="button"
                      onClick={() => toggleDiff(version.pricingVersion)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-slate-200 hover:bg-slate-900"
                    >
                      <span className="font-mono">
                        {tr('ops.pricing.history.entry', {
                          version: version.pricingVersion,
                          count: version.entryCount,
                          origin: tr(`ops.pricing.origin.${version.origin}` as TranslationKey),
                        })}
                      </span>
                      {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 space-y-1.5 text-[11px] text-slate-400">
                        <p>{tr('ops.pricing.history.reason', { reason: version.reason })}</p>
                        <p>{version.actor ? tr('ops.pricing.history.actor', { actor: version.actor }) : tr('ops.pricing.history.actorUnknown')}</p>
                        {!diff && (
                          <button
                            type="button"
                            onClick={() => toggleDiff(version.pricingVersion)}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                          >
                            {tr('ops.pricing.history.viewDiff')}
                          </button>
                        )}
                        {diff?.status === 'loading' && <p>{tr('ops.pricing.history.diffLoading')}</p>}
                        {diff?.status === 'error' && <p className="text-rose-400">{tr('ops.pricing.history.diffError')}</p>}
                        {diff?.status === 'ready' && (
                          <p>
                            {diff.diff.added.length === 0 && diff.diff.removed.length === 0 && diff.diff.changed.length === 0
                              ? tr('ops.pricing.history.diffNone')
                              : tr('ops.pricing.history.diffSummary', {
                                  added: diff.diff.added.length,
                                  removed: diff.diff.removed.length,
                                  changed: diff.diff.changed.length,
                                })}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

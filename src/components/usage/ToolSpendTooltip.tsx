/**
 * Accessible spend tooltip for a tool chip (issue #81). Opens on hover and keyboard focus, stays open while the
 * pointer is over the tooltip itself (WCAG 1.4.13, "hoverable"), and closes on blur or `Escape` from anywhere
 * (`Escape` is a window-level listener so it works even while the pointer, not focus, is over the tooltip).
 *
 * In demo mode (`ledger` is `null`) this renders its `children` unchanged, with no extra behavior: it never
 * invents a figure and never calls the server.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { t, type Locale } from '../../i18n';
import type { LedgerConnection } from '../modelOps/useModelOpsLedger';
import { useToolUsage } from './useToolUsage';
import { appTranslate, spendRows } from './spendFormat';

export interface ToolSpendTooltipProps {
  tool: string;
  agentId: string;
  taskId?: string;
  ledger: LedgerConnection | null;
  locale: Locale;
  className?: string;
  children: React.ReactNode;
}

const CLOSE_DELAY_MS = 150;

export const ToolSpendTooltip: React.FC<ToolSpendTooltipProps> = ({ tool, agentId, taskId, ledger, locale, className, children }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => cancelClose(), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const usage = useToolUsage({ ledger, agentId, taskId, enabled: open && ledger !== null });

  if (!ledger) {
    return <span className={className}>{children}</span>;
  }

  const translate = appTranslate(locale);
  const group = usage.status === 'ready'
    ? usage.data.groups.find((item) => item.key.tool === tool)
    : undefined;

  return (
    <span
      className={`relative inline-flex ${className ?? ''}`.trim()}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="absolute z-20 top-full left-0 mt-1 min-w-[180px] max-w-xs p-2.5 rounded-lg bg-slate-950 border border-slate-700 shadow-xl text-[11px] text-slate-200 font-mono space-y-1 normal-case"
        >
          {usage.status === 'loading' && <span className="block text-slate-400">{t(locale, 'tool.spend.loading')}</span>}
          {(usage.status === 'unavailable' || usage.status === 'unauthorized' || usage.status === 'error') && (
            <span className="block text-slate-400">{t(locale, 'tool.spend.unavailable')}</span>
          )}
          {usage.status === 'ready' && !group && (
            <span className="block text-slate-400">{t(locale, 'tool.spend.none')}</span>
          )}
          {usage.status === 'ready' && group && (
            <>
              {spendRows(group, locale, translate).map((row) => (
                <span key={row.key} className="flex justify-between gap-3">
                  <span className="text-slate-400">{row.label}</span>
                  <span className="text-slate-100">{row.value}</span>
                </span>
              ))}
            </>
          )}
        </span>
      )}
    </span>
  );
};

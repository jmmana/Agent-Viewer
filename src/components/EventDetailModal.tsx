import React, { useState, useEffect } from 'react';
import { ViewerEvent, Agent, Task } from '../types/agent';
import {
  X,
  Copy,
  Check,
  Terminal,
  Clock,
  Layers,
  AlertCircle,
  CheckCircle2,
  Users,
  MessageSquare,
  Radio,
  Eye,
  FileCode,
  DollarSign,
  Cpu,
} from 'lucide-react';

interface EventDetailModalProps {
  event: ViewerEvent | null;
  task?: Task | null;
  agents: Agent[];
  onClose: () => void;
  onFocusAgent?: (agent: Agent) => void;
}

export const EventDetailModal: React.FC<EventDetailModalProps> = ({
  event,
  task,
  agents,
  onClose,
  onFocusAgent,
}) => {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'json'>('details');

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!event && !task) return null;

  const sourceAgent = event ? agents.find((a) => a.id === event.source) : null;
  const targetAgent = event?.target ? agents.find((a) => a.id === event.target) : null;

  const handleCopyJSON = () => {
    const data = event || task;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatExactDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatRelativeTime = (timestamp: number) => {
    const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diff < 5) return 'Justo ahora';
    if (diff < 60) return `Hace ${diff} segundos`;
    const min = Math.floor(diff / 60);
    if (min < 60) return `Hace ${min} minuto${min > 1 ? 's' : ''}`;
    const hr = Math.floor(min / 60);
    return `Hace ${hr} hora${hr > 1 ? 's' : ''}`;
  };

  const getEventBadge = (type: string, severity: string) => {
    if (severity === 'critical') {
      return {
        bg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
        icon: <AlertCircle className="w-4 h-4 text-rose-400" />,
        label: 'Alerta Crítica',
      };
    }
    if (type.startsWith('tool')) {
      return {
        bg: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
        icon: <Terminal className="w-4 h-4 text-sky-400" />,
        label: 'Ejecución de Herramienta',
      };
    }
    if (type.startsWith('task.completed')) {
      return {
        bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
        icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
        label: 'Tarea Completada',
      };
    }
    if (type.startsWith('task.blocked')) {
      return {
        bg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
        icon: <AlertCircle className="w-4 h-4 text-rose-400" />,
        label: 'Tarea Bloqueada',
      };
    }
    if (type.startsWith('task')) {
      return {
        bg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
        icon: <Layers className="w-4 h-4 text-indigo-400" />,
        label: 'Actividad de Tarea',
      };
    }
    if (type.startsWith('meeting')) {
      return {
        bg: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
        icon: <Users className="w-4 h-4 text-purple-400" />,
        label: 'Reunión de Equipo',
      };
    }
    if (type.startsWith('message')) {
      return {
        bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        icon: <MessageSquare className="w-4 h-4 text-amber-400" />,
        label: 'Mensaje Inter-Agente',
      };
    }
    return {
      bg: 'bg-slate-800 text-slate-300 border-slate-700',
      icon: <Radio className="w-4 h-4 text-slate-400" />,
      label: 'Evento Operacional',
    };
  };

  const badge = event ? getEventBadge(event.type, event.severity) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-slate-100 animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-slate-950 border border-slate-800 text-white shadow-sm">
              {badge ? badge.icon : <Layers className="w-5 h-5 text-indigo-400" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-white text-base">
                  {event ? 'Detalle del Evento' : `Detalle de Tarea: ${task?.id}`}
                </h3>
                {badge && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${badge.bg}`}
                  >
                    {badge.label}
                  </span>
                )}
                {task && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    {task.status}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                ID: {event?.id || task?.id}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Tab switch */}
            <div className="flex bg-slate-950 rounded-lg p-0.5 border border-slate-800 text-xs">
              <button
                onClick={() => setActiveTab('details')}
                className={`px-3 py-1 rounded-md font-medium transition-colors ${
                  activeTab === 'details' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Detalles
              </button>
              <button
                onClick={() => setActiveTab('json')}
                className={`px-3 py-1 rounded-md font-medium transition-colors ${
                  activeTab === 'json' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Raw JSON
              </button>
            </div>

            {/* Close Button */}
            <button
              onClick={onClose}
              title="Cerrar modal (Esc)"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ml-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {activeTab === 'details' ? (
            <>
              {/* Event Summary / Description Card */}
              <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 shadow-sm">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block mb-1">
                  Descripción del Suceso
                </span>
                <p className="text-sm text-slate-200 leading-relaxed font-normal">
                  {event ? event.summary : task?.description}
                </p>
              </div>

              {/* Agents Involved & Timestamp Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Source Agent */}
                {sourceAgent && (
                  <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white shadow-md relative shrink-0"
                        style={{ backgroundColor: sourceAgent.clothingColor }}
                      >
                        <span>{sourceAgent.name.charAt(0)}</span>
                        <span className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-slate-900 bg-emerald-500" />
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">
                          Agente Emisor
                        </span>
                        <span className="font-bold text-white text-xs block">
                          {sourceAgent.name}
                        </span>
                        <span className="text-[11px] text-sky-400 block">
                          {sourceAgent.roleTitle}
                        </span>
                      </div>
                    </div>

                    {onFocusAgent && (
                      <button
                        onClick={() => {
                          onFocusAgent(sourceAgent);
                          onClose();
                        }}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors flex items-center gap-1"
                        title="Enfocar en oficina"
                      >
                        <Eye className="w-3.5 h-3.5 text-sky-400" />
                        <span>Enfocar</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Target Agent if present */}
                {targetAgent && (
                  <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white shadow-md relative shrink-0"
                        style={{ backgroundColor: targetAgent.clothingColor }}
                      >
                        <span>{targetAgent.name.charAt(0)}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">
                          Agente Destinatario
                        </span>
                        <span className="font-bold text-white text-xs block">
                          {targetAgent.name}
                        </span>
                        <span className="text-[11px] text-purple-400 block">
                          {targetAgent.roleTitle}
                        </span>
                      </div>
                    </div>

                    {onFocusAgent && (
                      <button
                        onClick={() => {
                          onFocusAgent(targetAgent);
                          onClose();
                        }}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors flex items-center gap-1"
                      >
                        <Eye className="w-3.5 h-3.5 text-purple-400" />
                        <span>Enfocar</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Timestamp & Timing Info */}
                <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold flex items-center gap-1.5 block mb-1">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    Marca de Tiempo
                  </span>
                  <span className="text-xs font-mono text-slate-200 block font-medium">
                    {formatExactDate(event ? event.timestamp : task?.createdAt || Date.now())}
                  </span>
                  <span className="text-[11px] text-slate-500 block mt-0.5">
                    {formatRelativeTime(event ? event.timestamp : task?.createdAt || Date.now())}
                  </span>
                </div>

                {/* Task Reference */}
                {(event?.taskId || task) && (
                  <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                    <span className="text-[10px] text-slate-500 uppercase font-semibold flex items-center gap-1.5 block mb-1">
                      <Layers className="w-3.5 h-3.5 text-indigo-400" />
                      Tarea Asociada
                    </span>
                    <span className="text-xs font-mono text-indigo-300 font-bold block">
                      {event?.taskId || task?.id}
                    </span>
                    <span className="text-[11px] text-slate-400 block truncate mt-0.5">
                      {task?.title || 'OAuth 2.0 PKCE Auth Server & Service Scopes'}
                    </span>
                  </div>
                )}
              </div>

              {/* Payload & Tool Details if present */}
              {event?.payload && Object.keys(event.payload).length > 0 && (
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-sky-400" />
                      <span>Parámetros & Payload de la Operación</span>
                    </span>
                    {event.payload.tool && (
                      <span className="font-mono text-xs text-sky-300 bg-sky-950 px-2 py-0.5 rounded border border-sky-800">
                        {event.payload.tool}
                      </span>
                    )}
                  </div>

                  <div className="space-y-2 text-xs">
                    {event.payload.text && (
                      <div>
                        <span className="text-[11px] text-slate-500 block font-semibold">
                          Mensaje / Texto emitido:
                        </span>
                        <p className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 mt-1 italic font-sans">
                          "{event.payload.text}"
                        </p>
                      </div>
                    )}

                    {event.payload.input && (
                      <div>
                        <span className="text-[11px] text-slate-500 block font-semibold">
                          Entrada (Input):
                        </span>
                        <pre className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 mt-1 font-mono text-[11px] overflow-x-auto">
                          {typeof event.payload.input === 'string'
                            ? event.payload.input
                            : JSON.stringify(event.payload.input, null, 2)}
                        </pre>
                      </div>
                    )}

                    {event.payload.output && (
                      <div>
                        <span className="text-[11px] text-slate-500 block font-semibold">
                          Salida (Output):
                        </span>
                        <pre className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-emerald-300 mt-1 font-mono text-[11px] overflow-x-auto">
                          {typeof event.payload.output === 'string'
                            ? event.payload.output
                            : JSON.stringify(event.payload.output, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Task Progress & Artifacts (If viewing task) */}
              {task && (
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
                      <FileCode className="w-4 h-4 text-emerald-400" />
                      <span>Artefactos & Herramientas ({task.artifacts.length})</span>
                    </span>
                    <span className="text-xs font-mono text-emerald-400">
                      Progreso: {task.progress}%
                    </span>
                  </div>

                  {task.artifacts.length > 0 ? (
                    <div className="space-y-2">
                      {task.artifacts.map((art) => (
                        <div
                          key={art.id}
                          className="flex items-center justify-between p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <FileCode className="w-4 h-4 text-sky-400" />
                            <div>
                              <span className="font-semibold text-white block">{art.name}</span>
                              <span className="text-[11px] text-slate-400 block">{art.summary}</span>
                            </div>
                          </div>
                          <span className="font-mono text-[10px] text-slate-500 uppercase bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                            {art.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 italic">No hay artefactos asociados.</p>
                  )}
                </div>
              )}
            </>
          ) : (
            /* RAW JSON VIEW */
            <div className="relative">
              <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-sky-300 overflow-x-auto leading-relaxed max-h-96">
                {JSON.stringify(event || task, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-900/90">
          <button
            onClick={handleCopyJSON}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors border border-slate-700/60"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400 font-semibold">¡Copiado!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Copiar JSON</span>
              </>
            )}
          </button>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors shadow-md"
          >
            Cerrar (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};

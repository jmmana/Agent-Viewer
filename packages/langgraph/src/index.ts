/**
 * LangGraph adapter for Agent Viewer (issue #344), published as `@warlockcode/agent-viewer-langgraph` with
 * `@langchain/core` and `@warlockcode/agent-viewer-sdk` as peer dependencies. Pass the handler in the graph
 * config and every node, tool and model run is reported through LangChain's own callback system:
 *
 *     const handler = new AgentViewerCallbackHandler({ url: 'http://localhost:8787', runtimeId: 'my-graph' });
 *     await graph.invoke(inputs, { callbacks: [handler], configurable: { thread_id: 'thread-1' } });
 *     await handler.flush();
 *
 * The mapping itself lives in `./core.ts`; this class only forwards the callbacks to it.
 */

// `@langchain/core` is a peer dependency the workspace root does not install, so the root `tsc --noEmit` may
// not find it; with the peer installed (any package build), its real types apply. Not `@ts-expect-error`,
// which would fail exactly when the module is present.
// @ts-ignore
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AgentViewerLangGraphCore, type AgentViewerLangGraphOptions, type AgentViewerLangGraphStats } from './core.js';

export {
  METADATA_WHITELIST,
  type AgentViewerLangGraphAgent,
  type AgentViewerLangGraphOptions,
  type AgentViewerLangGraphStats,
  type LangGraphMetadata,
  type LangGraphMetadataKey,
} from './core.js';

type Core = AgentViewerLangGraphCore;

/**
 * `awaitHandlers` is `true`, so `@langchain/core` waits for each callback before the graph moves on; every
 * callback only enqueues events and returns, so that wait never includes the network. Use `flush()` to wait
 * for the queue to drain and `stats()` for the cumulative counters.
 */
export class AgentViewerCallbackHandler extends BaseCallbackHandler {
  name = 'agent_viewer_langgraph';
  // Redeclared here because `@langchain/core` is an unresolved peer dependency at root `tsc --noEmit` time
  // (see the `@ts-ignore` above): with the base class typed as `any`, TypeScript gives this class no inherited
  // members, so assigning to inherited fields in the constructor needs them declared on the subclass too.
  // With the peer installed (any package build), these are the same fields `BaseCallbackHandler` already has.
  declare awaitHandlers: boolean;
  declare raiseError: boolean;

  private readonly core: Core;

  constructor(options: AgentViewerLangGraphOptions = {}) {
    // Nothing passed to super: BaseCallbackHandler keeps its input as serializable kwargs, and the options
    // may carry an API key.
    super();
    this.awaitHandlers = true;
    this.raiseError = false;
    this.core = new AgentViewerLangGraphCore(options);
  }

  /** The run map must be shared by every callback manager the handler is attached to, so a copy is itself. */
  copy(): this {
    return this;
  }

  get runtimeId(): string {
    return this.core.runtimeId;
  }

  flush(): Promise<void> {
    return this.core.flush();
  }

  stats(): AgentViewerLangGraphStats {
    return this.core.stats();
  }

  handleChainStart(...args: Parameters<Core['handleChainStart']>): void {
    this.core.handleChainStart(...args);
  }

  handleChainEnd(...args: Parameters<Core['handleChainEnd']>): void {
    this.core.handleChainEnd(...args);
  }

  handleChainError(...args: Parameters<Core['handleChainError']>): void {
    this.core.handleChainError(...args);
  }

  handleToolStart(...args: Parameters<Core['handleToolStart']>): void {
    this.core.handleToolStart(...args);
  }

  handleToolEnd(...args: Parameters<Core['handleToolEnd']>): void {
    this.core.handleToolEnd(...args);
  }

  handleToolError(...args: Parameters<Core['handleToolError']>): void {
    this.core.handleToolError(...args);
  }

  handleLLMStart(...args: Parameters<Core['handleLLMStart']>): void {
    this.core.handleLLMStart(...args);
  }

  handleChatModelStart(...args: Parameters<Core['handleChatModelStart']>): void {
    this.core.handleChatModelStart(...args);
  }

  handleLLMEnd(...args: Parameters<Core['handleLLMEnd']>): void {
    this.core.handleLLMEnd(...args);
  }

  handleLLMError(...args: Parameters<Core['handleLLMError']>): void {
    this.core.handleLLMError(...args);
  }
}

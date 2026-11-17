// S6: an agent may look for other agents while it answers, and hire one it found. Two ordinary Zynd tool steps do it:
//
//   Find agents    searchAgents; the AI writes only the search words. Nothing is paid.
//   Hire an agent  callAgent; the AI picks the agent (its `zns:…` id) and writes the request. The payer is always the
//                  agent's own wallet and the price ceiling is a fixed number the AI cannot change.
//
// This file holds the plain facts both the builder and the policy rely on. Only a type is imported, so nothing can loop.
import type { N8nNode } from '../n8n/policy';

/** The names other modules (policy, run reader, graph) look for. */
export const FIND_TOOL_NAME = 'Find agents';
export const HIRE_TOOL_NAME = 'Hire an agent';

/** The most one runtime hire may cost, USD (owner decision, 2026-11-17). Fixed in the step, never chosen by the AI. */
export const RUNTIME_HIRE_MAX_USD = '0.25';
/** How many runtime hires one question may make. Said to the AI; the price ceiling and the agent's credit are the hard stops. */
export const RUNTIME_HIRES_PER_QUESTION = 3;
/** How many search results the AI sees. */
export const SEARCH_LIMIT = 5;
/** The most results a search step may be set to return. */
export const SEARCH_LIMIT_MAX = 10;

/** The text of a fixed `$fromAI` hint (see `edit.ts`): letters, digits and a little punctuation, no quotes or braces. */
const HINT = String.raw`[\p{L}\p{N} ,.:()\-_/]{0,200}`;
const FROM_AI = (key: string) => new RegExp(String.raw`^=\{\{ /\*n8n-auto-generated-fromAI-override\*/ \$fromAI\('${key}', '${HINT}'\) \}\}$`, 'u');
const AGENT_ID_EXPRESSION = FROM_AI('agentId');

/** True only for the one expression Studio writes for "the AI picks the agent". Anything else in `agentId` is not it. */
export const isRuntimeAgentExpr = (v: unknown): boolean => typeof v === 'string' && AGENT_ID_EXPRESSION.test(v);

const ZYND_TOOL = 'CUSTOM.zyndTool';
const param = (n: N8nNode, k: string): unknown => n.parameters?.[k];

/** The step that searches the network (by what it does, not by its name). */
export const isFindStep = (n: N8nNode): boolean => n.type === ZYND_TOOL && param(n, 'operation') === 'searchAgents';
/** The step that hires an agent the AI picks. A helper hired by a fixed id is not this. */
export const isHireStep = (n: N8nNode): boolean => n.type === ZYND_TOOL && param(n, 'operation') === 'callAgent' && isRuntimeAgentExpr(param(n, 'agentId'));
export const hasNetworkSteps = (nodes: readonly N8nNode[]): boolean => nodes.some(isFindStep) && nodes.some(isHireStep);

/** What the AI step's system message says about finding and hiring, appended after the list of tools. */
export function networkRules(ownEntityId?: string): string {
  const self = ownEntityId && /^zns:[A-Za-z0-9_-]{8,80}$/.test(ownEntityId) ? ` You are the agent ${ownEntityId}: never hire yourself.` : ' Never hire yourself.';
  return (
    `Finding other agents: use your own tools first. Only when none of them can do a part of the request, use "${FIND_TOOL_NAME}" with a few plain words about what you need, ` +
    `pick the best match from the results (check what it does and its price), then use "${HIRE_TOOL_NAME}" with its exact id (it starts with zns:) and a clear request in plain words. ` +
    `Hire at most ${RUNTIME_HIRES_PER_QUESTION} agents for one request, never hire the same agent twice, and never hire one that costs more than $${RUNTIME_HIRE_MAX_USD} per call.${self} ` +
    `If nobody suitable turns up or a hire fails, say so plainly and answer with what you have.`
  );
}

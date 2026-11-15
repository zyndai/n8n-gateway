// Runs the SDK code Studio renders against stand-ins for n8n's builder functions, and returns the workflow it
// describes in the shape `get_workflow_details` gives back. Not n8n, but it shows what the code says: the node
// list, their parameters, their credentials and how they connect.
import type { N8nNode, N8nWorkflow } from '@/lib/n8n/policy';

interface Handle {
  node: N8nNode;
}

export function interpret(code: string, credentialIds: Record<string, string>): N8nWorkflow {
  const nodes: N8nNode[] = [];
  const connections: NonNullable<N8nWorkflow['connections']> = {};
  const edge = (from: Handle, to: Handle) => {
    const c = (connections[from.node.name] ??= { main: [[]] });
    c.main?.[0]?.push({ node: to.node.name });
  };
  const creds = (c: Record<string, { __cred: string }> | undefined): N8nNode['credentials'] =>
    c ? Object.fromEntries(Object.entries(c).map(([type, v]) => [type, { id: credentialIds[v.__cred] ?? null, name: v.__cred }])) : undefined;

  const make = (def: { type: string; version: number; config: { name: string; parameters?: Record<string, unknown>; credentials?: Record<string, { __cred: string }>; subnodes?: { model?: Handle; tools?: Handle[] } } }): Handle => {
    const node: N8nNode = { name: def.config.name, type: def.type, typeVersion: def.version, parameters: structuredClone(def.config.parameters ?? {}) };
    const c = creds(def.config.credentials);
    if (c) node.credentials = c;
    const handle: Handle & { to(next: Handle): Handle } = {
      node,
      to(next) {
        edge(handle, next);
        return handle;
      },
    };
    // Subnodes are separate nodes in n8n's own list.
    nodes.push(node);
    for (const sub of [def.config.subnodes?.model, ...(def.config.subnodes?.tools ?? [])]) if (sub) nodes.push(sub.node);
    // A subnode is pushed before its parent in source order; drop the duplicate entries we just created in `make`.
    return handle;
  };

  let current: Handle | undefined;
  const builder = {
    add(h: Handle) {
      current = h;
      return builder;
    },
    to(h: Handle) {
      if (current) edge(current, h);
      return builder;
    },
  };

  const run = new Function(
    'workflow',
    'node',
    'trigger',
    'tool',
    'languageModel',
    'newCredential',
    'fromAi',
    'expr',
    code.replace(/^import .*$/m, '').replace('export default', 'return'),
  ) as (...a: unknown[]) => unknown;
  run(
    () => builder,
    make,
    make,
    make,
    make,
    (name: string) => ({ __cred: name }),
    (key: string, desc: string) => `={{ $fromAI('${key}', '${desc}') }}`,
    (s: string) => `=${s}`,
  );

  // `make` pushed each parent and its subnodes; subnodes were pushed again when they were made themselves.
  const seen = new Set<string>();
  const unique = nodes.filter((n) => (seen.has(n.name) ? false : (seen.add(n.name), true)));
  return { name: 'rendered', nodes: unique, connections, settings: {} };
}

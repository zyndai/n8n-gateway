// A small stand-in for how n8n applies `update_workflow` operations to a workflow, covering the operations Studio
// writes itself. Unknown operations are ignored, so tests with their own made-up operations keep working.
import type { N8nNode, N8nWorkflow } from '../../lib/n8n/policy';

type Op = Record<string, unknown>;

export function applyOps(wf: N8nWorkflow, operations: unknown): void {
  for (const op of (Array.isArray(operations) ? operations : []) as Op[]) {
    switch (op.type) {
      case 'addNode': {
        const node = structuredClone(op.node) as N8nNode;
        if (wf.nodes.some((n) => n.name === node.name)) throw new Error(`A node named "${node.name}" already exists`);
        wf.nodes.push(node);
        break;
      }
      case 'removeNode': {
        const name = String(op.nodeName);
        if (!wf.nodes.some((n) => n.name === name)) throw new Error(`No node named "${name}"`);
        wf.nodes = wf.nodes.filter((n) => n.name !== name);
        delete wf.connections?.[name];
        for (const byType of Object.values(wf.connections ?? {})) {
          for (const lists of Object.values(byType)) lists?.forEach((list, i, all) => (all[i] = list ? list.filter((c) => c.node !== name) : list));
        }
        break;
      }
      case 'setNodeParameter': {
        const node = wf.nodes.find((n) => n.name === op.nodeName);
        if (!node) throw new Error(`No node named "${String(op.nodeName)}"`);
        const keys = String(op.path).split('/').filter(Boolean);
        let at = (node.parameters ??= {}) as Record<string, unknown>;
        for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
        at[keys[keys.length - 1] as string] = structuredClone(op.value);
        break;
      }
      case 'addConnection': {
        const type = String(op.connectionType ?? 'main');
        const byType = ((wf.connections ??= {})[String(op.source)] ??= {});
        const lists = (byType[type] ??= [[]]);
        (lists[Number(op.sourceIndex ?? 0)] ??= []).push({ node: String(op.target), type, index: Number(op.targetIndex ?? 0) });
        break;
      }
      case 'setNodeCredential': {
        const node = wf.nodes.find((n) => n.name === op.nodeName);
        if (!node) throw new Error(`No node named "${String(op.nodeName)}"`);
        (node.credentials ??= {})[String(op.credentialKey)] = { id: String(op.credentialId), name: String(op.credentialName ?? '') };
        break;
      }
      default:
        break;
    }
  }
}

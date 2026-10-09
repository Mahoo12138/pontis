// Reconciliation wire contract (doc 21 §9): the golden fixtures under
// fixtures/protocol/ are generated from the Go DTOs, so feeding them through
// the extension's own boundary validators is what keeps the two encodings
// from drifting apart. The lifecycle answers below are the shapes
// InitialSyncEngine resumes on after an MV3 worker kill.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ClientSnapshotWire } from './types';
import { isProtocolErrorCode } from './types';
import {
  ProtocolShapeError,
  parseReconciliationEnvelope,
  parseServerSnapshot,
  parseServerSnapshotPage,
  parseSteps,
} from './validate';

const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../fixtures/protocol');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

describe('reconciliation lifecycle envelope', () => {
  it('reads a planned session and the ambiguity it asks about', () => {
    const body = parseReconciliationEnvelope(golden('reconcile-session-planned-v1.json'));
    expect(body.session.state).toBe('waiting_user');
    expect(body.session.phase).toBe('planned');
    expect(body.session.binding_id).toBe('0198c0de-7000-7000-8000-000000000010');
    expect(body.session.server_committed).toBe(false);

    expect(body.issues).toHaveLength(1);
    const issue = body.issues[0]!;
    expect(issue.type).toBe('ambiguous_identity');
    expect(issue.payload.source_ref).toBe('l_3');
    // The client answers with one of these, or keeps the default.
    expect(issue.payload.candidates).toHaveLength(2);
    expect(issue.default_choice).toBe('');

    expect(body.plan?.plan_hash).toBe(body.session.plan_hash);
    expect(body.plan?.stats.creates).toBe(1);
    expect(body.plan?.warnings).toEqual([]);
  });

  it('reads the binding a completed session wrote back', () => {
    const body = parseReconciliationEnvelope(golden('reconcile-session-completed-v1.json'));
    expect(body.session.state).toBe('completed');
    expect(body.session.phase).toBe('committed');
    // The baseline the device starts its first ordinary round from.
    expect(body.session.commit_revision).toBe(121);
    expect(body.issues).toEqual([]);
    expect(body.binding?.state).toBe('active');
    expect(body.binding?.applied_revision).toBe(121);
  });

  // A lifecycle answer without a session cannot say where to resume, and an
  // issues array that is null would break the loop that walks the open ones.
  it('refuses an envelope that is missing its session or its issue list', () => {
    const planned = golden('reconcile-session-planned-v1.json') as Record<string, unknown>;
    expect(() => parseReconciliationEnvelope({ issues: planned['issues'] })).toThrow(ProtocolShapeError);
    expect(() => parseReconciliationEnvelope({ ...planned, issues: null })).toThrow(ProtocolShapeError);
    expect(() => parseReconciliationEnvelope({ session: planned['session'] })).toThrow(ProtocolShapeError);
  });
});

describe('reconciliation artifacts', () => {
  it('reads the apply steps of the plan it previewed', () => {
    const steps = parseSteps(golden('reconcile-steps-v1.json'));
    expect(steps.steps.map((s) => s.kind)).toEqual(['assign_identity', 'create']);
    expect(steps.steps[0]!.local_ref).toBe('l_2');
    expect(steps.steps[0]!.canonical_id).toBe('0198c0de-7000-7000-8000-0000000000aa');
    // A create carries the canonical identity, not a client ref.
    expect(steps.steps[1]!.local_ref).toBeUndefined();
    expect(steps.steps[1]!.parent).toEqual({ type: 'node', id: '0198c0de-7000-7000-8000-0000000000aa' });
  });

  it('reads a frozen snapshot and pages it by its own cursor', () => {
    const snap = parseServerSnapshot(golden('reconcile-server-snapshot-v1.json'));
    expect(snap.snapshot_id).toBe('0198c0de-7000-7000-8000-000000000100');
    expect(snap.node_count).toBe(4);

    const page = parseServerSnapshotPage(golden('reconcile-snapshot-nodes-v1.json'));
    expect(page.total).toBe(4);
    expect(page.nodes).toHaveLength(2);
    // The cursor is the offset into this snapshot's rows; empty means done.
    expect(page.next_cursor ?? '').toBe('2');
    // Root slots are rows too, which is why total is not the node count alone.
    expect(page.nodes[0]!.type).toBe('root');
    expect(page.nodes[0]!.root_key).toBe('main');
  });

  it('sends a client snapshot of session-local refs only', () => {
    const snapshot: ClientSnapshotWire = {
      epoch: 1,
      revision: 44,
      roots: [{ local_ref: 'l_1', root_key: 'main', title: 'Bookmarks Bar' }],
      nodes: [
        { local_ref: 'l_2', parent_local_ref: 'l_1', type: 'folder', title: 'Reading', url: '' },
        {
          local_ref: 'l_3',
          parent_local_ref: 'l_2',
          type: 'bookmark',
          title: 'Example',
          url: 'https://example.com',
        },
      ],
    };
    // The Go server decodes exactly this body (doc 08 §10).
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(golden('reconcile-client-snapshot-v1.json'));
  });

  it('classifies the busy-binding refusal as a protocol error', () => {
    // /sync raises it while a reconciliation session is open (doc 08 §8).
    expect(isProtocolErrorCode('RECONCILIATION_IN_PROGRESS')).toBe(true);
  });
});

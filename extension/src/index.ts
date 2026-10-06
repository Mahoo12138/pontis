// Pontis extension sync core (doc 19 §5): pure TypeScript replica and
// sync engine. WXT provides packaging only and never leaks into this
// domain layer.
export { FakeBrowserAdapter } from './adapter/fake';
export { ReplicaDB } from './store/db';
export { ReplicaStore } from './store/replica';
export { EventCapture } from './engine/capture';
export { RemoteApplier } from './engine/applier';
export { SyncCoordinator } from './engine/coordinator';
export { InitialReconciler } from './engine/initial';
export { ServerClient } from './engine/client';
export { ProtocolError } from '@pontis/protocol';
export type { SyncTransport } from './engine/client';

export type { BrowserAdapter, BrowserEvent, BrowserNode, BrowserRoot } from './adapter/types';
export type { BindingRow, MirrorNode, PendingOpRow, PendingState, RemoteChangeRow, ExpectedMutationRow } from './store/db';
export type { SyncRoundResult } from './engine/coordinator';

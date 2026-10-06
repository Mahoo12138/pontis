package reconcile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// Session types (doc 06 §1, doc 08 §11).
type SessionType string

const (
	TypeInitial    SessionType = "initial"
	TypeFullResync SessionType = "full_resync"
	TypeRecovery   SessionType = "recovery"
)

// Session states (doc 06 §3). Fine-grained progress lives in phase.
type SessionState string

const (
	StateRunning     SessionState = "running"
	StateWaitingUser SessionState = "waiting_user"
	StateCompleted   SessionState = "completed"
	StateFailed      SessionState = "failed"
)

// Session phases.
const (
	PhaseCollecting    = "collecting"     // waiting for the client snapshot
	PhaseSnapshotReady = "snapshot_ready" // client snapshot stored
	PhaseServerReady   = "server_ready"   // both snapshots exist
	PhasePlanned       = "planned"        // plan computed, awaiting commit
	PhaseCommitted     = "committed"      // server committed, applying steps
)

// Issue types.
const (
	IssueAmbiguousIdentity = "ambiguous_identity"
)

// SnapshotTTL bounds how long an uncommitted snapshot stays readable.
const SnapshotTTL = 24 * time.Hour

// Errors.
var (
	// ErrSessionNotFound is returned for unknown reconciliation ids.
	ErrSessionNotFound = errors.New("reconcile: session not found")
	// ErrActiveSessionExists is returned when the binding already runs a
	// reconciliation (doc 06 §3: one active session per binding).
	ErrActiveSessionExists = errors.New("reconcile: binding already has an active reconciliation")
	// ErrBindingNotEligible is returned when the binding state does not
	// allow the requested session type.
	ErrBindingNotEligible = errors.New("reconcile: binding not eligible for this session type")
	// ErrInvalidSessionState is returned when an operation does not match
	// the session's current state or phase.
	ErrInvalidSessionState = errors.New("reconcile: invalid session state")
	// ErrSnapshotMissing is returned when planning before both snapshots
	// exist.
	ErrSnapshotMissing = errors.New("reconcile: snapshots missing")
	// ErrPlanStale is returned when the canonical target moved since the
	// plan was computed (doc 08 §12).
	ErrPlanStale = errors.New("reconcile: plan stale")
	// ErrNotCommitted is returned when completing an uncommitted session.
	ErrNotCommitted = errors.New("reconcile: session not committed")
)

// Session is a persistent reconciliation (doc 06 §3, doc 18 §6).
type Session struct {
	ID                     string
	BindingID              string
	SpaceID                canonical.SpaceID
	Type                   SessionType
	Reason                 string
	State                  SessionState
	Phase                  string
	SourceEpoch            int64 // client-reported watermarks
	SourceRevision         int64
	TargetEpoch            int64 // server snapshot point
	TargetRevision         int64
	ClientSnapshotArtifact string
	ServerSnapshotArtifact string
	PlanArtifact           string
	StepsArtifact          string
	PlanHash               string
	ServerCommitted        bool
	CommitRevision         int64
	CreatedAt              time.Time
	UpdatedAt              time.Time
	CompletedAt            time.Time
}

// Artifact is a stored payload: client snapshot, plan or steps.
type Artifact struct {
	ID         string
	BindingID  string
	Kind       string
	Epoch      int64
	Revision   int64
	StorageKey string
	Content    []byte
	Checksum   string
	SizeBytes  int
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

// Artifact kinds.
const (
	ArtifactClientSnapshot = "client_snapshot"
	ArtifactServerSnapshot = "server_snapshot"
	ArtifactPlan           = "plan"
	ArtifactSteps          = "steps"
)

// ServerSnapshot is a frozen point-in-time view of the canonical tree
// (doc 08 §9): pagination always reads the same snapshot even as the
// live revision advances.
type ServerSnapshot struct {
	ID        string
	BindingID string
	SpaceID   canonical.SpaceID
	Epoch     int64
	Revision  int64
	NodeCount int
	Checksum  string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// SnapshotNode is one frozen node of a server snapshot.
type SnapshotNode struct {
	NodeRef   string
	ParentRef string
	Type      string
	Title     string
	URL       string
	RootKey   string
	Position  int64
}

// Issue is a user-visible reconciliation question (doc 08 §11
// decisions). V1 issues are identity ambiguities; the safe default is
// always the non-destructive one.
type Issue struct {
	ID               string
	ReconciliationID string
	Type             string
	Payload          IssuePayloadJSON
	DefaultChoice    string
	SelectedChoice   *string
	CreatedAt        time.Time
}

// Service implements the reconciliation session lifecycle.
type Service struct {
	store    Store
	executor *canonical.Executor
}

// NewService returns a reconciliation service backed by store.
func NewService(store Store) *Service {
	return &Service{store: store, executor: canonical.NewExecutor()}
}

func newID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("reconcile: generate id: %w", err)
	}
	return id.String(), nil
}

// CreateSession opens a reconciliation for the binding. Initial sessions
// require a pending binding; resync and recovery require an active one.
func (s *Service) CreateSession(ctx context.Context, bindingID string, typ SessionType, reason string) (Session, error) {
	binding, err := s.store.LoadBinding(ctx, bindingID)
	if err != nil {
		return Session{}, ErrSessionNotFound
	}
	switch {
	case typ == TypeInitial && binding.State != device.StatePendingInitial:
		return Session{}, ErrBindingNotEligible
	case typ != TypeInitial && binding.State != device.StateActive:
		return Session{}, ErrBindingNotEligible
	}
	if _, active, err := s.store.GetActiveSession(ctx, bindingID); err != nil {
		return Session{}, err
	} else if active {
		return Session{}, ErrActiveSessionExists
	}

	id, err := newID()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	sess := Session{
		ID:        id,
		BindingID: bindingID,
		SpaceID:   binding.SpaceID,
		Type:      typ,
		Reason:    reason,
		State:     StateRunning,
		Phase:     PhaseCollecting,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.store.InsertSession(ctx, sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

// SubmitClientSnapshot stores the browser snapshot for the binding's
// active session (doc 08 §10). The raw payload is kept verbatim as an
// artifact.
func (s *Service) SubmitClientSnapshot(ctx context.Context, bindingID string, snapshot ClientSnapshotJSON) (Session, error) {
	sess, err := s.loadActiveByBinding(ctx, bindingID)
	if err != nil {
		return Session{}, err
	}
	if sess.Phase != PhaseCollecting {
		return Session{}, ErrInvalidSessionState
	}
	if _, err := snapshot.Tree(); err != nil {
		return Session{}, fmt.Errorf("reconcile: %w", err)
	}
	content, err := marshalJSON(snapshot)
	if err != nil {
		return Session{}, err
	}
	artID, err := newID()
	if err != nil {
		return Session{}, err
	}
	art := Artifact{
		ID:         artID,
		BindingID:  sess.BindingID,
		Kind:       ArtifactClientSnapshot,
		StorageKey: "reconcile/" + sess.ID + "/client-snapshot",
		Content:    content,
		Checksum:   checksum(content),
		SizeBytes:  len(content),
		CreatedAt:  time.Now().UTC(),
	}
	if err := s.store.InsertArtifact(ctx, art); err != nil {
		return Session{}, err
	}
	if err := s.store.UpdateSessionSnapshot(ctx, sess.ID, PhaseSnapshotReady,
		art.ID, snapshot.Epoch, snapshot.Revision, time.Now().UTC()); err != nil {
		return Session{}, err
	}
	return s.store.GetSession(ctx, sess.ID)
}

// CreateServerSnapshot freezes the canonical tree for the binding's
// active session (doc 08 §9) and stores it with metadata and a content
// checksum. Creating twice returns the existing snapshot.
func (s *Service) CreateServerSnapshot(ctx context.Context, bindingID string) (ServerSnapshot, error) {
	sess, err := s.loadActiveByBinding(ctx, bindingID)
	if err != nil {
		return ServerSnapshot{}, err
	}
	if sess.ServerSnapshotArtifact != "" {
		return s.store.GetServerSnapshotByArtifact(ctx, sess.ServerSnapshotArtifact)
	}
	if sess.Phase != PhaseSnapshotReady {
		return ServerSnapshot{}, ErrInvalidSessionState
	}
	return s.freezeServerSnapshot(ctx, sess)
}

// freezeServerSnapshot captures the current canonical state in one
// transaction and rebinds the session to the fresh snapshot. Re-planning
// after PLAN_STALE uses it to re-preview against the new head.
func (s *Service) freezeServerSnapshot(ctx context.Context, sess Session) (ServerSnapshot, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return ServerSnapshot{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	space, err := tx.LoadSpace(ctx, sess.SpaceID)
	if err != nil {
		return ServerSnapshot{}, err
	}
	roots, err := tx.ListRootSlots(ctx, sess.SpaceID)
	if err != nil {
		return ServerSnapshot{}, err
	}

	id, err := newID()
	if err != nil {
		return ServerSnapshot{}, err
	}
	now := time.Now().UTC()
	snap := ServerSnapshot{
		ID:        id,
		BindingID: sess.BindingID,
		SpaceID:   sess.SpaceID,
		Epoch:     space.Epoch,
		Revision:  space.CurrentRevision,
		CreatedAt: now,
		ExpiresAt: now.Add(SnapshotTTL),
	}

	// Collect everything first: the row carries the true node count.
	hasher := sha256.New()
	nodes := make([]SnapshotNode, 0, 16)
	for _, root := range roots {
		frozen := SnapshotNode{
			NodeRef:  RootRef(root.Key),
			Type:     string(NodeRoot),
			Title:    root.DisplayName,
			RootKey:  root.Key,
			Position: root.Position,
		}
		fmt.Fprintf(hasher, "%s\x1f%s\x1f%s\x1f%s\x1e", frozen.NodeRef, frozen.ParentRef, frozen.Type, frozen.Title)
		nodes = append(nodes, frozen)
		if err := s.collectSubtree(ctx, tx, sess.SpaceID, frozen.NodeRef, &nodes, hasher, 0); err != nil {
			return ServerSnapshot{}, err
		}
	}
	snap.NodeCount = len(nodes)
	snap.Checksum = hex.EncodeToString(hasher.Sum(nil))

	if err := tx.InsertServerSnapshot(ctx, snap, nodes); err != nil {
		return ServerSnapshot{}, err
	}
	art := Artifact{
		ID:         id, // one artifact row per snapshot, same id
		BindingID:  sess.BindingID,
		Kind:       ArtifactServerSnapshot,
		Epoch:      snap.Epoch,
		Revision:   snap.Revision,
		StorageKey: "reconcile/" + sess.ID + "/server-snapshot/" + id,
		Checksum:   snap.Checksum,
		ExpiresAt:  snap.ExpiresAt,
		CreatedAt:  now,
	}
	if err := tx.InsertArtifact(ctx, art); err != nil {
		return ServerSnapshot{}, err
	}
	if err := tx.UpdateSessionServerSnapshot(ctx, sess.ID, PhaseServerReady, id, snap.Epoch, snap.Revision, now); err != nil {
		return ServerSnapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ServerSnapshot{}, err
	}
	committed = true
	return snap, nil
}

// collectSubtree appends the frozen nodes under parent to out, feeding
// the checksum in stable walk order.
func (s *Service) collectSubtree(ctx context.Context, tx Tx, space canonical.SpaceID, parent string, out *[]SnapshotNode, hasher hashIface, depth int) error {
	if depth > 10_000 {
		return errors.New("reconcile: canonical tree too deep")
	}
	parentRef := parentRefOf(parent)
	children, err := tx.Children(ctx, space, parentRef)
	if err != nil {
		return err
	}
	for pos, node := range children {
		frozen := SnapshotNode{
			NodeRef:   string(node.ID),
			ParentRef: parent,
			Type:      string(node.Type),
			Title:     node.Title,
			URL:       node.URL,
			Position:  int64(pos),
		}
		*out = append(*out, frozen)
		fmt.Fprintf(hasher, "%s\x1f%s\x1f%s\x1f%s\x1f%s\x1e",
			frozen.NodeRef, frozen.ParentRef, frozen.Type, frozen.Title, frozen.URL)
		if err := s.collectSubtree(ctx, tx, space, frozen.NodeRef, out, hasher, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// hashIface is the subset of hash.Hash the checksum uses.
type hashIface interface {
	Write(p []byte) (n int, err error)
	Sum(b []byte) []byte
}

// parentRefOf maps a frozen parent ref back to a canonical ParentRef.
func parentRefOf(ref string) canonical.ParentRef {
	if isRootRef(ref) {
		return canonical.NewRootParent(ref[5:])
	}
	return canonical.NewNodeParent(canonical.NodeID(ref))
}

// Plan computes the reconciliation plan and the client apply steps from
// both snapshots, records ambiguity issues, and stores both artifacts.
// With pending issues the session moves to waiting_user; decisions then
// recompute the plan (doc 08 §11-12).
func (s *Service) Plan(ctx context.Context, sessionID string) (Session, []Issue, error) {
	sess, err := s.loadActive(ctx, sessionID)
	if err != nil {
		return Session{}, nil, err
	}
	if sess.ClientSnapshotArtifact == "" || sess.ServerSnapshotArtifact == "" {
		return Session{}, nil, ErrSnapshotMissing
	}
	if sess.Phase != PhaseSnapshotReady && sess.Phase != PhaseServerReady && sess.Phase != PhasePlanned {
		return Session{}, nil, ErrInvalidSessionState
	}
	// Re-plan after PLAN_STALE previews against the new canonical head:
	// refresh the frozen snapshot when the head has moved on (doc 08 §12).
	space, err := s.store.LoadSpace(ctx, sess.SpaceID)
	if err != nil {
		return Session{}, nil, err
	}
	if space.Epoch != sess.TargetEpoch || space.CurrentRevision != sess.TargetRevision {
		if _, err := s.freezeServerSnapshot(ctx, sess); err != nil {
			return Session{}, nil, err
		}
		sess, err = s.store.GetSession(ctx, sessionID)
		if err != nil {
			return Session{}, nil, err
		}
	}
	sess, issues, _, err := s.computeAndStorePlan(ctx, sess, nil)
	if err != nil {
		return Session{}, nil, err
	}
	return sess, issues, nil
}

// Decide records user decisions on issues and recomputes the plan with
// them folded in (doc 08 §11).
func (s *Service) Decide(ctx context.Context, sessionID string, decisions map[string]string) (Session, []Issue, error) {
	sess, err := s.loadActive(ctx, sessionID)
	if err != nil {
		return Session{}, nil, err
	}
	if sess.State != StateWaitingUser {
		return Session{}, nil, ErrInvalidSessionState
	}
	issues, err := s.store.ListIssues(ctx, sessionID)
	if err != nil {
		return Session{}, nil, err
	}
	known := map[string]string{} // source ref → current selection
	for _, issue := range issues {
		choice := issue.DefaultChoice
		if issue.SelectedChoice != nil {
			choice = *issue.SelectedChoice
		}
		known[issue.Payload.SourceRef] = choice
	}
	for issueID, choice := range decisions {
		found := false
		for _, issue := range issues {
			if issue.ID == issueID {
				found = true
				break
			}
		}
		if !found {
			return Session{}, nil, ErrInvalidSessionState
		}
		if err := s.store.ResolveIssue(ctx, issueID, choice, time.Now().UTC()); err != nil {
			return Session{}, nil, err
		}
		known[issueIDToSourceRef(issues, issueID)] = choice
	}
	// Empty choice keeps the safe default (duplicate create).
	d := Decisions{}
	for ref, choice := range known {
		d[ref] = choice
	}
	sess, issues, _, err = s.computeAndStorePlan(ctx, sess, d)
	if err != nil {
		return Session{}, nil, err
	}
	return sess, issues, nil
}

func issueIDToSourceRef(issues []Issue, issueID string) string {
	for _, issue := range issues {
		if issue.ID == issueID {
			return issue.Payload.SourceRef
		}
	}
	return ""
}

// computeAndStorePlan runs the engine for the session type, persists the
// plan and steps artifacts and the issue rows, and updates the session.
func (s *Service) computeAndStorePlan(ctx context.Context, sess Session, decisions Decisions) (Session, []Issue, Artifact, error) {
	clientArt, err := s.store.GetArtifact(ctx, sess.ClientSnapshotArtifact)
	if err != nil {
		return Session{}, nil, Artifact{}, ErrSnapshotMissing
	}
	var snapshot ClientSnapshotJSON
	if err := unmarshalJSON(clientArt.Content, &snapshot); err != nil {
		return Session{}, nil, Artifact{}, err
	}
	clientTree, err := snapshot.Tree()
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	serverTree, err := s.loadSnapshotTree(ctx, sess.ServerSnapshotArtifact)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	var match *MatchResult
	var policy Policy
	var clientResolver identityResolver
	switch sess.Type {
	case TypeInitial:
		match, err = MatchExact(clientTree, serverTree)
		policy = Policy{Strategy: StrategyMerge, Placement: PlacementContents}
		clientResolver = sourceRefIdentity{}
	case TypeRecovery:
		match, err = MatchExact(clientTree, serverTree)
		policy = Policy{Strategy: StrategyPreserve, Placement: PlacementContents}
		clientResolver = sourceRefIdentity{}
	case TypeFullResync:
		match, err = MatchByCanonicalID(serverTree, clientTree)
		policy = Policy{Strategy: StrategyReplace, Placement: PlacementContents}
		clientResolver = newCanonicalIdentity(clientTree)
	default:
		return Session{}, nil, Artifact{}, fmt.Errorf("reconcile: unknown session type %q", sess.Type)
	}
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	// Fold the decisions first: resolved ambiguities leave the issue set,
	// and BuildDesired replans on the resolved view.
	resolved, err := foldDecisions(match, decisions)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	desired, err := BuildDesired(resolved, policy, decisions, func() (string, error) { return newID() })
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	// Server-side plan: only the initial merge mutates the canonical tree.
	var plan *Plan
	if sess.Type == TypeInitial {
		plan, err = BuildPlan(serverTree, desired, policy, newCanonicalIdentity(serverTree))
	} else {
		plan, err = BuildPlan(serverTree, desired, policy, noopIdentity{})
	}
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	steps, err := DeriveClientSteps(clientTree, desired, policy, clientResolver)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	// Issues for every unresolved ambiguity.
	issues := make([]Issue, 0, len(match.Ambiguous))
	for _, a := range resolved.Ambiguous {
		id, err := newID()
		if err != nil {
			return Session{}, nil, Artifact{}, err
		}
		payload := IssuePayloadJSON{SourceRef: a.SourceRef, Candidates: a.Candidates}
		if node, ok := snapshotNodeOf(snapshot, a.SourceRef); ok {
			payload.Type = NodeType(node.Type)
			payload.Title = node.Title
			payload.URL = node.URL
		}
		issues = append(issues, Issue{
			ID:               id,
			ReconciliationID: sess.ID,
			Type:             IssueAmbiguousIdentity,
			Payload:          payload,
			DefaultChoice:    "", // duplicate-create
			CreatedAt:        time.Now().UTC(),
		})
	}

	planJSON := PlanArtifactJSON{
		Type:         string(sess.Type),
		Strategy:     policy.Strategy,
		Placement:    policy.Placement,
		BaseEpoch:    sess.TargetEpoch,
		BaseRevision: sess.TargetRevision,
		PlanHash:     plan.Hash,
		Operations:   make([]PrimitiveJSON, 0, len(plan.Operations)),
		Stats: StatsJSON{
			Creates: plan.Stats.Creates,
			Updates: plan.Stats.Updates,
			Moves:   plan.Stats.Moves,
			Deletes: plan.Stats.Deletes,
		},
		Warnings: plan.Warnings,
	}
	for _, op := range plan.Operations {
		planJSON.Operations = append(planJSON.Operations, PrimitiveJSON{
			Kind:      op.Kind,
			NodeID:    op.NodeID,
			Type:      op.Type,
			Title:     op.Title,
			URL:       op.URL,
			Parent:    parentToJSON(op.Parent),
			BeforeID:  op.BeforeID,
			SourceRef: op.SourceRef,
		})
	}
	planContent, err := marshalJSON(planJSON)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	stepsJSON := StepsArtifactJSON{PlanHash: plan.Hash, Steps: make([]StepJSON, 0, len(steps))}
	for _, st := range steps {
		stepsJSON.Steps = append(stepsJSON.Steps, StepJSON{
			Kind:        st.Kind,
			LocalRef:    st.LocalRef,
			CanonicalID: st.CanonicalID,
			Type:        st.Type,
			Title:       st.Title,
			URL:         st.URL,
			Parent:      parentToJSON(st.Parent),
			BeforeID:    st.BeforeID,
		})
	}
	stepsContent, err := marshalJSON(stepsJSON)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}

	now := time.Now().UTC()
	planArtID, err := newID()
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	stepsArtID, err := newID()
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	planArt := Artifact{
		ID:         planArtID,
		BindingID:  sess.BindingID,
		Kind:       ArtifactPlan,
		Epoch:      sess.TargetEpoch,
		Revision:   sess.TargetRevision,
		StorageKey: "reconcile/" + sess.ID + "/plan",
		Content:    planContent,
		Checksum:   checksum(planContent),
		SizeBytes:  len(planContent),
		CreatedAt:  now,
	}
	stepsArt := Artifact{
		ID:         stepsArtID,
		BindingID:  sess.BindingID,
		Kind:       ArtifactSteps,
		Epoch:      sess.TargetEpoch,
		Revision:   sess.TargetRevision,
		StorageKey: "reconcile/" + sess.ID + "/steps",
		Content:    stepsContent,
		Checksum:   checksum(stepsContent),
		SizeBytes:  len(stepsContent),
		CreatedAt:  now,
	}
	if err := s.store.InsertArtifact(ctx, planArt); err != nil {
		return Session{}, nil, Artifact{}, err
	}
	if err := s.store.InsertArtifact(ctx, stepsArt); err != nil {
		return Session{}, nil, Artifact{}, err
	}
	if err := s.store.ReplaceIssues(ctx, sess.ID, issues); err != nil {
		return Session{}, nil, Artifact{}, err
	}

	state := StateRunning
	phase := PhasePlanned
	if len(issues) > 0 {
		state = StateWaitingUser
		phase = PhasePlanned
	}
	if err := s.store.UpdateSessionPlan(ctx, sess.ID, string(state), phase, planArt.ID, stepsArt.ID, plan.Hash, now); err != nil {
		return Session{}, nil, Artifact{}, err
	}
	updated, err := s.store.GetSession(ctx, sess.ID)
	if err != nil {
		return Session{}, nil, Artifact{}, err
	}
	return updated, issues, planArt, nil
}

// noopIdentity treats every desired node as absent from the current
// tree: the plan degenerates to an empty operation list, which is what
// resync/recovery commit does server-side.
type noopIdentity struct{}

func (noopIdentity) currentRef(*DesiredNode) string { return "" }

// loadSnapshotTree rebuilds the engine input tree from a frozen server
// snapshot.
func (s *Service) loadSnapshotTree(ctx context.Context, artifactID string) (*Tree, error) {
	snap, err := s.store.GetServerSnapshotByArtifact(ctx, artifactID)
	if err != nil {
		return nil, err
	}
	nodes, err := s.store.ListSnapshotNodes(ctx, snap.ID, 0, snap.NodeCount+1)
	if err != nil {
		return nil, err
	}
	treeNodes := make([]TreeNode, 0, len(nodes))
	for _, n := range nodes {
		treeNode := TreeNode{
			Ref:       n.NodeRef,
			ParentRef: n.ParentRef,
			Title:     n.Title,
			URL:       n.URL,
		}
		switch n.Type {
		case "root":
			treeNode.Type = NodeRoot
			treeNode.RootKey = n.RootKey
		case "folder":
			treeNode.Type = NodeFolder
		case "bookmark":
			treeNode.Type = NodeBookmark
		}
		if treeNode.Type != NodeRoot {
			// Canonical identity: for server snapshots the ref is the id.
			treeNode.CanonicalID = n.NodeRef
		}
		treeNodes = append(treeNodes, treeNode)
	}
	tr := &Tree{Nodes: treeNodes}
	if _, err := tr.index(); err != nil {
		return nil, err
	}
	return tr, nil
}

func snapshotNodeOf(snapshot ClientSnapshotJSON, localRef string) (ClientNodeJSON, bool) {
	for _, node := range snapshot.Nodes {
		if node.LocalRef == localRef {
			return node, true
		}
	}
	return ClientNodeJSON{}, false
}

// Commit applies the plan. For an initial merge the operations run
// atomically through the canonical executor; the session base must still
// match the canonical head, otherwise the plan is stale (doc 08 §12).
// Resync and recovery commit no server-side changes and only confirm the
// session so the client can apply its steps.
func (s *Service) Commit(ctx context.Context, sessionID string) (Session, error) {
	sess, err := s.loadActive(ctx, sessionID)
	if err != nil {
		return Session{}, err
	}
	if sess.Phase != PhasePlanned || sess.PlanArtifact == "" {
		return Session{}, ErrInvalidSessionState
	}

	// Everything the commit transaction needs is read up front: the
	// single-connection pool must never be asked for a second connection
	// while the transaction holds one.
	var planJSON *PlanArtifactJSON
	var deviceID string
	if sess.Type == TypeInitial {
		planArt, err := s.store.GetArtifact(ctx, sess.PlanArtifact)
		if err != nil {
			return Session{}, err
		}
		planJSON = &PlanArtifactJSON{}
		if err := unmarshalJSON(planArt.Content, planJSON); err != nil {
			return Session{}, err
		}
		if planJSON.PlanHash != sess.PlanHash {
			return Session{}, ErrInvalidSessionState
		}
		binding, err := s.store.LoadBinding(ctx, sess.BindingID)
		if err != nil {
			return Session{}, err
		}
		deviceID = binding.DeviceID
	}

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return Session{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	space, err := tx.LoadSpace(ctx, sess.SpaceID)
	if err != nil {
		return Session{}, err
	}

	commitRevision := space.CurrentRevision
	if sess.Type == TypeInitial {
		if space.Epoch != sess.TargetEpoch || space.CurrentRevision != sess.TargetRevision {
			return Session{}, ErrPlanStale
		}
		origin := canonical.Origin{
			Type:      canonical.OriginReconciliation,
			UserID:    space.OwnerUserID,
			DeviceID:  canonical.DeviceID(deviceID),
			BindingID: canonical.BindingID(sess.BindingID),
		}
		cmds := make([]canonical.Command, 0, len(planJSON.Operations))
		for _, op := range planJSON.Operations {
			cmd, err := canonicalCommand(space.ID, op)
			if err != nil {
				return Session{}, err
			}
			cmds = append(cmds, cmd)
		}
		// An empty plan (e.g. empty space meeting an empty browser)
		// records no ChangeSet at all.
		if len(cmds) > 0 {
			planSummary := "初始导入浏览器书签"
			if sess.Type == TypeRecovery {
				planSummary = "恢复合并"
			}
			if _, err := s.executor.ApplyTxChangeSet(ctx, tx, origin, space.ID, canonical.ChangeSetInput{
				Kind:    "reconciliation",
				Summary: planSummary,
			}, cmds...); err != nil {
				return Session{}, err
			}
		}
		head, err := tx.LoadSpace(ctx, sess.SpaceID)
		if err != nil {
			return Session{}, err
		}
		commitRevision = head.CurrentRevision
	}

	now := time.Now().UTC()
	if err := tx.MarkSessionCommitted(ctx, sess.ID, commitRevision, now); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	committed = true
	return s.store.GetSession(ctx, sessionID)
}

// canonicalCommand maps a planned primitive onto a canonical executor
// command. Node ids were pre-assigned at plan time, so creates are
// deterministic for the client's assign_identity steps.
func canonicalCommand(space canonical.SpaceID, op PrimitiveJSON) (canonical.Command, error) {
	switch op.Kind {
	case KindCreate:
		return canonical.CreateNode{
			SpaceID:  space,
			NodeID:   canonical.NodeID(op.NodeID),
			Type:     canonical.NodeType(op.Type),
			Title:    op.Title,
			URL:      op.URL,
			Parent:   parentFromJSON(op.Parent),
			BeforeID: beforeID(op.BeforeID),
		}, nil
	case KindUpdateTitle:
		return canonical.UpdateNodeTitle{SpaceID: space, NodeID: canonical.NodeID(op.NodeID), Title: op.Title}, nil
	case KindUpdateURL:
		return canonical.UpdateNodeURL{SpaceID: space, NodeID: canonical.NodeID(op.NodeID), URL: op.URL}, nil
	case KindMove:
		return canonical.MoveNode{
			SpaceID:  space,
			NodeID:   canonical.NodeID(op.NodeID),
			Parent:   parentFromJSON(op.Parent),
			BeforeID: beforeID(op.BeforeID),
		}, nil
	case KindDelete:
		return canonical.DeleteNode{SpaceID: space, NodeID: canonical.NodeID(op.NodeID)}, nil
	default:
		return nil, fmt.Errorf("reconcile: unknown plan operation kind %q", op.Kind)
	}
}

func beforeID(id string) *canonical.NodeID {
	if id == "" {
		return nil
	}
	nodeID := canonical.NodeID(id)
	return &nodeID
}

// GetSessionWithIssues loads a session together with its issue rows.
func (s *Service) GetSessionWithIssues(ctx context.Context, sessionID string) (Session, []Issue, error) {
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return Session{}, nil, ErrSessionNotFound
	}
	issues, err := s.store.ListIssues(ctx, sessionID)
	if err != nil {
		return Session{}, nil, err
	}
	return sess, issues, nil
}

// GetServerSnapshot loads snapshot metadata.
func (s *Service) GetServerSnapshot(ctx context.Context, snapshotID string) (ServerSnapshot, error) {
	snap, err := s.store.GetServerSnapshotByArtifact(ctx, snapshotID)
	if err != nil {
		return ServerSnapshot{}, ErrSessionNotFound
	}
	return snap, nil
}

// ListSnapshotNodes reads one page of a frozen snapshot.
func (s *Service) ListSnapshotNodes(ctx context.Context, snapshotID string, offset, limit int) ([]SnapshotNode, error) {
	return s.store.ListSnapshotNodes(ctx, snapshotID, offset, limit)
}

// Steps returns the stored client apply steps (doc 08 §13).
func (s *Service) Steps(ctx context.Context, sessionID string) (StepsArtifactJSON, error) {
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return StepsArtifactJSON{}, ErrSessionNotFound
	}
	if !sess.ServerCommitted || sess.StepsArtifact == "" {
		return StepsArtifactJSON{}, ErrInvalidSessionState
	}
	art, err := s.store.GetArtifact(ctx, sess.StepsArtifact)
	if err != nil {
		return StepsArtifactJSON{}, err
	}
	var steps StepsArtifactJSON
	if err := unmarshalJSON(art.Content, &steps); err != nil {
		return StepsArtifactJSON{}, err
	}
	return steps, nil
}

// Complete finishes the session and resets the binding baseline
// (doc 06 §8): the binding watermarks jump to the committed revision so
// the next /sync pulls only post-reconciliation changes.
func (s *Service) Complete(ctx context.Context, sessionID string) (Session, error) {
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return Session{}, ErrSessionNotFound
	}
	if sess.State == StateCompleted {
		return sess, nil
	}
	if sess.State == StateFailed || !sess.ServerCommitted {
		return Session{}, ErrNotCommitted
	}

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return Session{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	space, err := tx.LoadSpace(ctx, sess.SpaceID)
	if err != nil {
		return Session{}, err
	}
	// Baseline reset (doc 06 §8): the client state matches the commit
	// head after an initial merge, but only the snapshot point for a
	// resync — anything newer flows in through the next /sync rounds.
	baseline := sess.CommitRevision
	if sess.Type != TypeInitial {
		baseline = sess.TargetRevision
	}
	if err := tx.CompleteSession(ctx, sess.ID, time.Now().UTC()); err != nil {
		return Session{}, err
	}
	if err := tx.FinalizeBinding(ctx, sess.BindingID, space.Epoch, baseline, baseline, time.Now().UTC()); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	committed = true
	return s.store.GetSession(ctx, sessionID)
}

// loadActive fetches the session and verifies it is still open.
func (s *Service) loadActive(ctx context.Context, sessionID string) (Session, error) {
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return Session{}, ErrSessionNotFound
	}
	if sess.State != StateRunning && sess.State != StateWaitingUser {
		return Session{}, ErrInvalidSessionState
	}
	return sess, nil
}

// loadActiveByBinding resolves the binding's open session. Snapshot
// endpoints are binding-scoped (doc 08 §9-10): a binding runs at most
// one active reconciliation.
func (s *Service) loadActiveByBinding(ctx context.Context, bindingID string) (Session, error) {
	sess, found, err := s.store.GetActiveSession(ctx, bindingID)
	if err != nil {
		return Session{}, err
	}
	if !found {
		return Session{}, ErrSessionNotFound
	}
	return sess, nil
}

func checksum(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// bindingDeviceID resolves the owning device of a binding for origin
// bookkeeping.
func bindingDeviceID(ctx context.Context, store Store, bindingID string) string {
	binding, err := store.LoadBinding(ctx, bindingID)
	if err != nil {
		return ""
	}
	return binding.DeviceID
}

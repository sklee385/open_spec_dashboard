export type FlowEntry = { path: string; index: string; worktree: string; untracked?: boolean; selectable?: boolean; reason?: string };
export type WorkspacePreview = {
  kind: string | null; status: string; available: boolean; experimentalEnabled: boolean; executionPath: string | null; branch: string | null; baseCommit: string | null; projectId: string | null;
  preparation: { stage: string; status: string; error?: string }[];
  git?: { state: string; reason?: string; copyEligible: boolean; head: string | null; branch: string | null; selectedBranch: string | null; baseCommit: string | null; branches: { name: string; commit: string }[] } | null;
  documents?: { confirmationToken: string; planRevision: string; manifest: { files: { path: string }[] }; excluded: FlowEntry[]; guidance?: string } | null;
};
export type IntegrationRequest = { id: string; candidateId: string; status: string; version: number; targetBranch: string; targetHead: string; workHead: string; executionPath: string; resultCommit?: string; candidateCommit?: string; candidateMutationVersion?: string; conflicts: string[]; error?: string };
export type ReservationPreview = { workHead: string; sourceBranch: string | null; sourceHead: string; reviewedVersion: string; branches: { name: string; commit: string }[] };
export type CommitPreview = { integrationId: string; version: string; head: string; entries: FlowEntry[] };
export type CandidatePreview = { candidateId: string; candidateVersion: string; targetHead: string; resultCommit: string; executionPath: string; branch: string };
export type CandidateEditPreview = { candidateId: string; candidateVersion: string; mode: 'conflict' | 'revision'; head: string; entries: FlowEntry[]; conflicts: string[] };
export type CandidateRun = { workId?: string; candidateId?: string; candidateVersion?: string; id: string; status: string; fresh: boolean; processTerminated?: boolean; requestKey?: string; error?: string; commands: { id?: string; command?: string; status: string; stdout?: string; stderr?: string; output?: string; exitCode?: number }[] };
export type CandidateVerification = { verificationPlan?: { scope: 'work' | 'full'; reason: string; choiceVersion: string }; candidateId: string; candidateVersion?: string; executionPath?: string; commands?: { id: string; command: string; args: string[] }[]; runs: CandidateRun[]; cliPassed: boolean; ready: boolean; browserRequired: boolean; browserStatus: string; error?: string };
export type ApplyReceipt = { workId?: string; candidateId?: string; expectedVersion?: string; processTerminated?: boolean; requestKey: string; status: string; applied?: boolean; appliedCommit?: string; observedHead?: string; error?: string; createdAt?: string; endedAt?: string };
export type ApplyObservation = { state: string; head?: string; reason?: string; sideChanged?: boolean; last?: ApplyObservation };
export type CandidateApplyStatus = { candidateId: string; receipt: ApplyReceipt | null; receipts: ApplyReceipt[]; live: { state: 'active' | 'unknown' | 'settled'; reason?: string }; observation: ApplyObservation };

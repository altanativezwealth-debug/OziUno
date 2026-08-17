/** Tenant-agent Product Run scope helpers (consumer workspace isolation). */

export interface TenantDelegationScope {
  sessionId: string;
  token: string;
  consumerWorkspaceId: string;
  agentSlug: string;
  /** Consumer-scoped wses_ session bootstrapped at serve time (EmailGate equivalent). */
  workspaceSessionId?: string;
  /** Workspace owner email used for the bootstrapped session. */
  email?: string;
  /**
   * U7 — standing-access (non-conversational) context: the app UI renders
   * with tenant chat hidden and no delegated conversation may start (R13).
   */
  chatSuppressed?: boolean;
}

export function getTenantDelegationScope(): TenantDelegationScope | null {
  if (typeof window === 'undefined') return null;

  const injected = (window as Window & { __TENANT_DELEGATION__?: TenantDelegationScope })
    .__TENANT_DELEGATION__;
  if (
    injected?.sessionId &&
    injected?.token &&
    injected?.consumerWorkspaceId &&
    injected?.agentSlug
  ) {
    return injected;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('ta_session');
  const token = params.get('delegation_token');
  if (!sessionId || !token) return null;

  return {
    sessionId,
    token,
    consumerWorkspaceId: '',
    agentSlug: '',
  };
}

/** True when Product Run / tenant delegation credentials are present. */
export function hasTenantDelegationAuth(): boolean {
  const scope = getTenantDelegationScope();
  if (scope?.sessionId && scope?.token) return true;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return !!(params.get('ta_session') && params.get('delegation_token'));
}

/**
 * U7 — task-mode Product Run artifact context (injected server-side into the
 * release-owned document; carries NO ids and NO credentials). Its presence
 * means the canonical task conversation lives in the PARENT chrome and this
 * document must never run its own chat.
 */
export interface TenantTaskModeContext {
  taskMode?: boolean;
  protocolVersion: number;
  nonce: string;
  capabilities?: string[];
}

export function getTenantTaskModeContext(): TenantTaskModeContext | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as Window & { __TENANT_TASK_MODE__?: TenantTaskModeContext })
    .__TENANT_TASK_MODE__;
  if (injected && typeof injected.nonce === 'string' && injected.nonce) {
    return injected;
  }
  return null;
}

/**
 * U7 — provider-space chat suppression (R42, plan U7 "space-chat
 * suppression"). True under a validated tenant-task artifact context
 * (window.__TENANT_TASK_MODE__) or a standing-access delegation
 * (chatSuppressed marker): the space's own chat must load no history, send
 * no greeting, open no WebSocket, upload no attachments, and never call
 * /space/:spaceId/chat/*. The canonical task conversation renders in parent
 * chrome instead; the server refuses suppressed contexts as a second layer.
 */
export function isTenantChatSuppressed(): boolean {
  if (getTenantTaskModeContext()) return true;
  const scope = getTenantDelegationScope();
  return scope?.chatSuppressed === true;
}

/** localStorage key for space visitor sessions — scoped per consumer in delegation. */
export function scopedSpaceSessionStorageKey(spaceId: string): string {
  const scope = getTenantDelegationScope();
  const consumerWorkspaceId = scope?.consumerWorkspaceId?.trim();
  if (consumerWorkspaceId) {
    return `space_session_${spaceId}__consumer_${consumerWorkspaceId}`;
  }
  return `space_session_${spaceId}`;
}

/** Auth fields for space chat APIs when running under tenant delegation. */
export function getDelegationChatRequestExtras(): {
  delegationToken: string;
  taSessionId: string;
} | null {
  // Suppressed contexts (task mode / standing access) never carry chat
  // credentials — the request would be refused server-side anyway.
  if (isTenantChatSuppressed()) return null;
  const scope = getTenantDelegationScope();
  if (!scope?.token || !scope.sessionId) return null;
  return {
    delegationToken: scope.token,
    taSessionId: scope.sessionId,
  };
}

import React, { useCallback, useState } from 'react';
import ManagerApprovalModal from '../components/pos/ManagerApprovalModal';

/**
 * Runs a permission-gated action, falling back to a manager PIN when the
 * signed-in employee's role isn't granted the permission itself.
 *
 * The backend does the deciding: routes declared with
 * `requireAuth(perm, { allowApproval: true })` answer 403 + `approval_required`
 * when the actor's role falls short but an approval would be accepted. That's
 * the only trigger for the PIN pad — the client never predicts the outcome from
 * `hasPermission()`, so a cashier at a shop that *has* granted the permission
 * is never prompted, and the roster can change without a redeploy.
 *
 * Usage:
 *   const { run, approvalModal } = useManagerApproval();
 *   await run((token) => deleteOrder(order.id, token));
 *   ...
 *   {approvalModal}
 */

/** Thrown when the operator dismisses the PIN pad. Callers stay quiet on this. */
export class ApprovalCancelled extends Error {
  constructor() {
    super('Manager approval cancelled');
    this.name = 'ApprovalCancelled';
  }
}

type ApprovableAction<T> = (approvalToken?: string) => Promise<T>;

interface PendingApproval {
  permission: string;
  resolve: (token: string | null) => void;
}

export function useManagerApproval() {
  const [pending, setPending] = useState<PendingApproval | null>(null);

  const run = useCallback(async <T,>(action: ApprovableAction<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      const e = err as Error & { approvalRequired?: boolean; permission?: string };
      if (!e.approvalRequired) throw err;

      const token = await new Promise<string | null>((resolve) => {
        setPending({ permission: e.permission || '', resolve });
      });
      if (!token) throw new ApprovalCancelled();

      // One retry only. A second approval_required here would mean the token
      // was rejected server-side (expired, wrong permission), and re-prompting
      // in a loop is worse than surfacing it.
      return action(token);
    }
  }, []);

  const approvalModal = pending ? (
    <ManagerApprovalModal
      permission={pending.permission}
      onApproved={(result) => {
        pending.resolve(result.approval_token);
        setPending(null);
      }}
      onClose={() => {
        pending.resolve(null);
        setPending(null);
      }}
    />
  ) : null;

  return { run, approvalModal };
}

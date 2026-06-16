import type { CfdiInvoice } from '../../types';

interface Props {
  invoice: CfdiInvoice;
  onCancel: (motive: string, substituteUUID?: string) => Promise<void>;
  onClose: () => void;
}

export default function CancellationModal(_props: Props) {
  return null;
}

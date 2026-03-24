import React from 'react';

interface Props {
  connection: any;
  accounts: any[];
  onSync: (id: string) => Promise<void>;
  onDisconnect: (id: string) => Promise<void>;
}

export default function BankConnectionCard({ connection, accounts, onSync, onDisconnect }: Props) {
  return null;
}

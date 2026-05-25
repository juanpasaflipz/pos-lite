import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Monitor, Plus, Trash2, Pencil, Check, X, ChefHat, Wine, ScanLine } from 'lucide-react';
import { listPairedDevices, pairDeviceClaim, renamePairedDevice, revokePairedDevice, type PairedDevice } from '../api';
import BrandLogo from '../components/BrandLogo';
import { useToast } from '../context/ToastContext';

const TYPE_META: Record<PairedDevice['device_type'], { icon: React.ReactNode; label: string }> = {
  kds: { icon: <ChefHat size={18} />, label: 'Kitchen' },
  bar: { icon: <Wine size={18} />, label: 'Bar' },
  expo: { icon: <ScanLine size={18} />, label: 'Expo' },
};

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DevicesScreen() {
  const { addToast } = useToast();
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showClaim, setShowClaim] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimLabel, setClaimLabel] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const load = async () => {
    try {
      setLoading(true);
      setDevices(await listPairedDevices());
    } catch (err: any) {
      addToast(err?.message || 'Failed to load devices', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleClaim = async () => {
    const code = claimCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      addToast('Enter the 6-character code shown on the TV', 'warning');
      return;
    }
    setClaiming(true);
    try {
      await pairDeviceClaim(code, claimLabel.trim() || undefined);
      addToast('Device paired', 'success');
      setShowClaim(false);
      setClaimCode('');
      setClaimLabel('');
      await load();
    } catch (err: any) {
      addToast(err?.message || 'Could not pair device', 'error');
    } finally {
      setClaiming(false);
    }
  };

  const handleRename = async (id: string) => {
    const label = editLabel.trim();
    if (!label) {
      setEditingId(null);
      return;
    }
    try {
      await renamePairedDevice(id, label);
      addToast('Renamed', 'success');
      setEditingId(null);
      await load();
    } catch (err: any) {
      addToast(err?.message || 'Could not rename', 'error');
    }
  };

  const handleRevoke = async (id: string, label: string | null) => {
    if (!confirm(`Revoke "${label || 'this device'}"? It will stop receiving orders immediately.`)) return;
    try {
      await revokePairedDevice(id);
      addToast('Device revoked', 'success');
      await load();
    } catch (err: any) {
      addToast(err?.message || 'Could not revoke', 'error');
    }
  };

  const active = devices.filter(d => !d.revoked_at);
  const revoked = devices.filter(d => d.revoked_at);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <Link to="/admin/cockpit" className="p-2 hover:bg-neutral-800 rounded-lg" title="Back">
          <ArrowLeft size={20} />
        </Link>
        <BrandLogo />
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Monitor size={24} className="text-brand-500" />
            Paired Devices
          </h1>
          <p className="text-sm text-neutral-400">Wall-mounted KDS screens and other paired displays.</p>
        </div>
        <button
          onClick={() => setShowClaim(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-500 rounded-lg font-semibold"
        >
          <Plus size={18} />
          Pair new device
        </button>
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-8">
        <section className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-5">
          <h2 className="font-semibold mb-2">How to pair a TV</h2>
          <ol className="text-sm text-neutral-400 list-decimal pl-5 space-y-1">
            <li>On the TV's browser, open <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-brand-400">/#/kitchen-pair</code> on this tenant's URL.</li>
            <li>The TV will show a 6-character code.</li>
            <li>Click <strong>Pair new device</strong> above and enter that code.</li>
            <li>The TV jumps into the kitchen display automatically — no employee login needed.</li>
          </ol>
        </section>

        {loading ? (
          <div className="text-neutral-500 text-center py-12">Loading...</div>
        ) : active.length === 0 && revoked.length === 0 ? (
          <div className="text-neutral-500 text-center py-12 border border-dashed border-neutral-800 rounded-xl">
            No devices paired yet.
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <section>
                <h2 className="text-sm uppercase tracking-wider text-neutral-500 mb-3">Active ({active.length})</h2>
                <ul className="space-y-2">
                  {active.map(d => (
                    <li key={d.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex items-center gap-4">
                      <div className="text-brand-400">{TYPE_META[d.device_type]?.icon}</div>
                      <div className="flex-1 min-w-0">
                        {editingId === d.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              value={editLabel}
                              onChange={e => setEditLabel(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleRename(d.id);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
                              placeholder="e.g. Main Kitchen TV"
                            />
                            <button onClick={() => handleRename(d.id)} className="p-1.5 hover:bg-neutral-800 rounded text-cockpit-green">
                              <Check size={16} />
                            </button>
                            <button onClick={() => setEditingId(null)} className="p-1.5 hover:bg-neutral-800 rounded text-neutral-500">
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="font-semibold truncate">
                              {d.device_label || <span className="italic text-neutral-500">Unnamed {TYPE_META[d.device_type]?.label}</span>}
                            </div>
                            <div className="text-xs text-neutral-500">
                              {TYPE_META[d.device_type]?.label} · Last seen {formatLastSeen(d.last_seen_at)}
                              {d.claimed_by_name && <> · Paired by {d.claimed_by_name}</>}
                            </div>
                          </>
                        )}
                      </div>
                      {editingId !== d.id && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { setEditingId(d.id); setEditLabel(d.device_label || ''); }}
                            className="p-2 hover:bg-neutral-800 rounded text-neutral-400"
                            title="Rename"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            onClick={() => handleRevoke(d.id, d.device_label)}
                            className="p-2 hover:bg-cockpit-red/20 rounded text-cockpit-red"
                            title="Revoke"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {revoked.length > 0 && (
              <section>
                <h2 className="text-sm uppercase tracking-wider text-neutral-500 mb-3">Revoked ({revoked.length})</h2>
                <ul className="space-y-2 opacity-60">
                  {revoked.map(d => (
                    <li key={d.id} className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4 flex items-center gap-4">
                      <div className="text-neutral-600">{TYPE_META[d.device_type]?.icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate line-through">{d.device_label || `Unnamed ${TYPE_META[d.device_type]?.label}`}</div>
                        <div className="text-xs text-neutral-500">
                          Revoked {d.revoked_at ? new Date(d.revoked_at).toLocaleDateString() : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>

      {showClaim && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-xl font-bold">Pair new device</h3>
            <p className="text-sm text-neutral-400">
              Enter the 6-character code shown on the TV at <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-brand-400">/#/kitchen-pair</code>.
            </p>
            <div>
              <label className="block text-xs uppercase text-neutral-500 mb-1.5">Pairing code</label>
              <input
                autoFocus
                value={claimCode}
                onChange={e => setClaimCode(e.target.value.toUpperCase())}
                maxLength={6}
                placeholder="ABC234"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-3 font-mono text-2xl tracking-[0.4em] text-center"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-neutral-500 mb-1.5">Label (optional)</label>
              <input
                value={claimLabel}
                onChange={e => setClaimLabel(e.target.value)}
                placeholder="e.g. Main Kitchen TV"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setShowClaim(false); setClaimCode(''); setClaimLabel(''); }}
                className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 rounded-lg font-semibold"
                disabled={claiming}
              >
                Cancel
              </button>
              <button
                onClick={handleClaim}
                disabled={claiming || claimCode.length !== 6}
                className="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded-lg font-semibold"
              >
                {claiming ? 'Pairing...' : 'Pair'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

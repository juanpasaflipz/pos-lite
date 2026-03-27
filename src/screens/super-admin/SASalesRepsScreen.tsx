import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';

interface SalesRep {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  conversions: number;
  active_clients: number;
  created_at?: string;
}

function getSecret(): string {
  return sessionStorage.getItem('admin_secret') || '';
}

export default function SASalesRepsScreen() {
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchReps = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/admin/agent/sales-reps', {
        headers: { 'x-admin-secret': getSecret() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error: ${res.status}`);
      }
      const data = await res.json();
      setReps(Array.isArray(data) ? data : data.reps || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReps();
  }, [fetchReps]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white tracking-tight">Sales Reps</h2>
        <button
          onClick={fetchReps}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {loading && reps.length === 0 ? (
        <p className="text-neutral-400 animate-pulse py-8 text-center">Loading sales reps...</p>
      ) : reps.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-center">
          <p className="text-neutral-500">No sales reps found</p>
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Role</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-right px-4 py-3 font-medium">Conversions</th>
                  <th className="text-right px-4 py-3 font-medium">Active Clients</th>
                </tr>
              </thead>
              <tbody>
                {reps.map(rep => (
                  <tr key={rep.id} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{rep.name}</td>
                    <td className="px-4 py-3 text-neutral-400">{rep.email}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-neutral-700/50 text-neutral-300 capitalize">
                        {rep.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${rep.active ? 'text-green-400' : 'text-neutral-500'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${rep.active ? 'bg-green-400' : 'bg-neutral-500'}`} />
                        {rep.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-300">{rep.conversions}</td>
                    <td className="px-4 py-3 text-right text-neutral-300">{rep.active_clients}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

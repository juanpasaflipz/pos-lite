import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicReceipt, PublicReceiptResponse } from '../api';

const formatMoney = (n: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);

const formatDateTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
};

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: PublicReceiptResponse }
  | { kind: 'error'; message: string };

const PublicReceiptScreen: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!token) {
      setState({ kind: 'error', message: 'Token no proporcionado' });
      return;
    }
    let cancelled = false;
    getPublicReceipt(token)
      .then((data) => { if (!cancelled) setState({ kind: 'ok', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err.message || 'No pudimos cargar el recibo' }); });
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
        <p className="text-neutral-500">Cargando recibo...</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
        <div className="bg-white rounded-2xl shadow p-8 text-center max-w-sm">
          <p className="text-red-600 font-semibold mb-2">No pudimos cargar el recibo</p>
          <p className="text-neutral-500 text-sm">{state.message}</p>
        </div>
      </div>
    );
  }

  const { tenant, order } = state.data;
  const paid = order.payment_status === 'paid' || order.payment_status === 'completed';

  return (
    <div className="min-h-screen bg-neutral-100 py-8 px-4 print:bg-white print:py-0">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm mx-auto overflow-hidden print:shadow-none print:rounded-none">
        <div className="p-6 text-center border-b-2 border-gray-200">
          <h1 className="text-2xl font-black tracking-tight text-neutral-900 mb-1">{tenant.name}</h1>
          <p className="text-neutral-500 text-sm">Recibo digital</p>
        </div>

        <div className="p-6 space-y-4 text-sm">
          <div className="text-center border-b pb-3">
            <p className="font-bold text-lg">Pedido #{order.order_number}</p>
            <p className="text-neutral-600">{formatDateTime(order.created_at)}</p>
            {paid && (
              <span className="inline-block mt-2 px-3 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded-full">
                PAGADO {order.payment_method ? `· ${order.payment_method.toUpperCase()}` : ''}
              </span>
            )}
          </div>

          <div className="space-y-2 border-b pb-3">
            {order.items.map((item) => (
              <div key={item.id} className="flex justify-between">
                <div className="flex-1">
                  <p className="font-semibold">{item.item_name}</p>
                  {item.notes && <p className="text-neutral-500 text-xs">{item.notes}</p>}
                </div>
                <div className="text-right text-neutral-700">
                  <p>{item.quantity}x {formatMoney(item.unit_price)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-neutral-500 text-sm">
              <p>Subtotal</p>
              <p>{formatMoney(order.subtotal)}</p>
            </div>
            <div className="flex justify-between text-neutral-500 text-sm">
              <p>IVA</p>
              <p>{formatMoney(order.tax)}</p>
            </div>
            {order.tip > 0 && (
              <div className="flex justify-between text-neutral-500 text-sm">
                <p>Propina</p>
                <p>{formatMoney(order.tip)}</p>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg pt-2 border-t mt-2">
              <p>Total</p>
              <p>{formatMoney(Number(order.total) + (Number(order.tip) || 0))}</p>
            </div>
          </div>

          <div className="text-center pt-3 border-t">
            <p className="text-neutral-600 text-xs">¡Gracias por tu visita!</p>
          </div>
        </div>

        <div className="p-4 border-t print:hidden">
          <button
            onClick={() => window.print()}
            className="w-full py-3 bg-neutral-800 text-white font-bold rounded-lg hover:bg-neutral-700"
          >
            Imprimir / Guardar PDF
          </button>
        </div>
      </div>
    </div>
  );
};

export default PublicReceiptScreen;

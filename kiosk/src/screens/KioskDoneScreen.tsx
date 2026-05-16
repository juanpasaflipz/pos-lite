import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskDoneScreen: React.FC = () => {
  const navigate = useNavigate();
  const { lastOrder, setLastOrder } = useKioskCart();
  useIdleTimer(() => {
    setLastOrder(null);
    navigate('/');
  }, 8_000);

  return (
    <div className="h-full w-full bg-emerald-700 text-white flex flex-col items-center justify-center p-8 text-center">
      <CheckCircle2 className="h-32 w-32 mb-8" />
      <h1 className="text-6xl font-black mb-5">Orden enviada</h1>
      {lastOrder && (
        <div className="mb-10">
          <p className="text-8xl font-black">#{lastOrder.order_number}</p>
          <p className="text-3xl font-black mt-4">{money.format(lastOrder.total)}</p>
          <p className="text-2xl text-white/80 mt-3">
            {lastOrder.payment_choice === 'counter_cash' ? 'Paga en caja' : 'Pago aprobado'}
          </p>
        </div>
      )}
      <button
        onClick={() => {
          setLastOrder(null);
          navigate('/');
        }}
        className="h-16 px-10 rounded-lg bg-white text-emerald-800 text-xl font-black"
      >
        Listo
      </button>
    </div>
  );
};

export default KioskDoneScreen;

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
      <CheckCircle2 className="h-36 w-36 mb-8" />
      <h1 className="text-[72px] font-black mb-6 leading-none">Orden enviada</h1>
      {lastOrder && (
        <div className="mb-12">
          <p className="text-[104px] font-black leading-none">#{lastOrder.order_number}</p>
          <p className="text-4xl font-black mt-5">{money.format(lastOrder.total)}</p>
          <p className="text-3xl text-white/85 font-bold mt-4">
            {lastOrder.payment_choice === 'counter_cash' ? 'Paga en caja' : 'Pago aprobado'}
          </p>
        </div>
      )}
      <button
        onClick={() => {
          setLastOrder(null);
          navigate('/');
        }}
        className="h-20 px-12 rounded-lg bg-white text-emerald-800 text-2xl font-black"
      >
        Listo
      </button>
    </div>
  );
};

export default KioskDoneScreen;

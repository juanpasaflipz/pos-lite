import React from 'react';
import { CheckCircle2, Gift } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskDoneScreen: React.FC = () => {
  const navigate = useNavigate();
  const { lastOrder, callName, setLastOrder, setCallName } = useKioskCart();
  const { session, clearSession } = useKioskCustomer();
  const greetingName = session?.firstName || callName;

  const finish = () => {
    setLastOrder(null);
    setCallName(null);
    clearSession();
    navigate('/');
  };

  useIdleTimer(finish, 8_000);

  return (
    <div className="h-full w-full bg-cockpit-green text-white flex flex-col items-center justify-center p-8 text-center">
      <CheckCircle2 className="h-36 w-36 mb-8" />
      <h1 className="text-[72px] font-black mb-6 leading-none">
        {greetingName ? `¡Gracias, ${greetingName}!` : 'Orden enviada'}
      </h1>
      {lastOrder && (
        <div className="mb-10">
          <p className="text-[104px] font-black leading-none">#{lastOrder.order_number}</p>
          <p className="text-4xl font-black mt-5">{money.format(lastOrder.total)}</p>
          <p className="text-3xl text-white/85 font-bold mt-4">
            {lastOrder.payment_choice === 'counter_cash' ? 'Paga en caja' : 'Pago aprobado'}
          </p>
        </div>
      )}
      {session && (
        <div className="mb-10 inline-flex items-center gap-3 rounded-full bg-white/15 px-6 py-3 text-2xl font-black">
          <Gift className="h-8 w-8" />
          {session.stamp?.completed
            ? '¡Tienes un premio esperándote!'
            : 'Cada visita te acerca a tu recompensa'}
        </div>
      )}
      <button
        onClick={finish}
        className="h-20 px-12 rounded-lg bg-white text-cockpit-green text-2xl font-black"
      >
        Listo
      </button>
    </div>
  );
};

export default KioskDoneScreen;

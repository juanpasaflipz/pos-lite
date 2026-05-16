import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { KioskBindingProvider, useKioskBinding } from './context/KioskBindingContext';
import { KioskCartProvider } from './context/KioskCartContext';
import AttractScreen from './screens/AttractScreen';
import BindDeviceScreen from './screens/BindDeviceScreen';
import AdminBindScreen from './screens/AdminBindScreen';
import KioskMenuScreen from './screens/KioskMenuScreen';
import KioskCartScreen from './screens/KioskCartScreen';
import KioskPaymentScreen from './screens/KioskPaymentScreen';
import KioskDoneScreen from './screens/KioskDoneScreen';

const Routed: React.FC = () => {
  const { tenantId, kioskToken } = useKioskBinding();

  if (!tenantId || !kioskToken) {
    return (
      <Routes>
        <Route path="/bind" element={<BindDeviceScreen />} />
        <Route path="/admin-bind" element={<AdminBindScreen />} />
        <Route path="*" element={<Navigate to="/bind" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<AttractScreen />} />
      <Route path="/menu" element={<KioskMenuScreen />} />
      <Route path="/cart" element={<KioskCartScreen />} />
      <Route path="/pay" element={<KioskPaymentScreen />} />
      <Route path="/done" element={<KioskDoneScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

const App: React.FC = () => (
  <HashRouter>
    <KioskBindingProvider>
      <KioskCartProvider>
        <Routed />
      </KioskCartProvider>
    </KioskBindingProvider>
  </HashRouter>
);

export default App;

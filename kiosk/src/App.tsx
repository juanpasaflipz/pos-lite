import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { startKioskUpdateWatcher } from './lib/kioskUpdate';
import { KioskBindingProvider, useKioskBinding } from './context/KioskBindingContext';
import { KioskCartProvider } from './context/KioskCartContext';
import { KioskCustomerProvider } from './context/KioskCustomerContext';
import { KioskSuggestionsProvider } from './context/KioskSuggestionsContext';
import AttractScreen from './screens/AttractScreen';
import BindDeviceScreen from './screens/BindDeviceScreen';
import AdminBindScreen from './screens/AdminBindScreen';
import KioskFulfillmentScreen from './screens/KioskFulfillmentScreen';
import KioskMemberScreen from './screens/KioskMemberScreen';
import KioskDeliveryAddressScreen from './screens/KioskDeliveryAddressScreen';
import KioskMenuScreen from './screens/KioskMenuScreen';
import KioskCartScreen from './screens/KioskCartScreen';
import KioskCallNameScreen from './screens/KioskCallNameScreen';
import KioskPayExistingScreen from './screens/KioskPayExistingScreen';
import KioskHoldConfirmationScreen from './screens/KioskHoldConfirmationScreen';
import KioskTerminalSettingsScreen from './screens/KioskTerminalSettingsScreen';
import KioskUnavailableScreen from './screens/KioskUnavailableScreen';

const Routed: React.FC = () => {
  const { tenantId, kioskToken, planLocked } = useKioskBinding();

  // Version polling + device heartbeat need the kiosk token, so this starts
  // once bound. Runs even while plan-locked — a parked kiosk should still
  // report in and still pick up a new build.
  useEffect(() => {
    if (!tenantId || !kioskToken) return;
    startKioskUpdateWatcher({ tenantId, kioskToken });
  }, [tenantId, kioskToken]);

  if (!tenantId || !kioskToken) {
    return (
      <Routes>
        <Route path="/bind" element={<BindDeviceScreen />} />
        <Route path="/admin-bind" element={<AdminBindScreen />} />
        <Route path="*" element={<Navigate to="/bind" replace />} />
      </Routes>
    );
  }

  // Kiosk is a Pro feature (repackaged 2026-07-23). While the plan doesn't
  // include it, park the whole app on the unavailable screen — binding stays,
  // so upgrading brings it back without re-pairing.
  if (planLocked) {
    return <KioskUnavailableScreen />;
  }

  return (
    <Routes>
      <Route path="/" element={<AttractScreen />} />
      <Route path="/member" element={<KioskMemberScreen />} />
      <Route path="/fulfillment" element={<KioskFulfillmentScreen />} />
      <Route path="/delivery-address" element={<KioskDeliveryAddressScreen />} />
      <Route path="/menu" element={<KioskMenuScreen />} />
      <Route path="/cart" element={<KioskCartScreen />} />
      <Route path="/name" element={<KioskCallNameScreen />} />
      <Route path="/pay-existing" element={<KioskPayExistingScreen />} />
      <Route path="/hold-confirmed" element={<KioskHoldConfirmationScreen />} />
      <Route path="/terminal-settings" element={<KioskTerminalSettingsScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

const App: React.FC = () => (
  <HashRouter>
    <KioskBindingProvider>
      <KioskSuggestionsProvider>
        <KioskCustomerProvider>
          <KioskCartProvider>
            <Routed />
          </KioskCartProvider>
        </KioskCustomerProvider>
      </KioskSuggestionsProvider>
    </KioskBindingProvider>
  </HashRouter>
);

export default App;

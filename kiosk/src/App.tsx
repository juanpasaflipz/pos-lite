import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { KioskBindingProvider, useKioskBinding } from './context/KioskBindingContext';
import { KioskCartProvider } from './context/KioskCartContext';
import { KioskCustomerProvider } from './context/KioskCustomerContext';
import { KioskSuggestionsProvider } from './context/KioskSuggestionsContext';
import AttractScreen from './screens/AttractScreen';
import BindDeviceScreen from './screens/BindDeviceScreen';
import AdminBindScreen from './screens/AdminBindScreen';
import KioskWelcomeScreen from './screens/KioskWelcomeScreen';
import KioskHomeScreen from './screens/KioskHomeScreen';
import KioskIdentifyScreen from './screens/KioskIdentifyScreen';
import KioskFulfillmentScreen from './screens/KioskFulfillmentScreen';
import KioskDeliveryAddressScreen from './screens/KioskDeliveryAddressScreen';
import KioskLookupScreen from './screens/KioskLookupScreen';
import KioskMenuScreen from './screens/KioskMenuScreen';
import KioskCartScreen from './screens/KioskCartScreen';
import KioskPayExistingScreen from './screens/KioskPayExistingScreen';
import KioskPostOrderChoiceScreen from './screens/KioskPostOrderChoiceScreen';
import KioskHoldConfirmationScreen from './screens/KioskHoldConfirmationScreen';

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
      <Route path="/home" element={<KioskHomeScreen />} />
      <Route path="/fulfillment" element={<KioskFulfillmentScreen />} />
      <Route path="/delivery-address" element={<KioskDeliveryAddressScreen />} />
      <Route path="/welcome" element={<KioskWelcomeScreen />} />
      <Route path="/identify" element={<KioskIdentifyScreen />} />
      <Route path="/menu" element={<KioskMenuScreen />} />
      <Route path="/cart" element={<KioskCartScreen />} />
      <Route path="/pagar" element={<KioskLookupScreen mode="pay" />} />
      <Route path="/agregar" element={<KioskLookupScreen mode="agregar" />} />
      <Route path="/pay-existing" element={<KioskPayExistingScreen />} />
      <Route path="/post-order-choice" element={<KioskPostOrderChoiceScreen />} />
      <Route path="/hold-confirmed" element={<KioskHoldConfirmationScreen />} />
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

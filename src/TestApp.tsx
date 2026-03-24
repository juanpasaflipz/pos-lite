import React, { useState } from 'react';

const TestProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [count, setCount] = useState(0);
  return <div onClick={() => setCount(c => c + 1)}>Count: {count} {children}</div>;
};

export default function TestApp() {
  return (
    <TestProvider>
      <p>Hello World</p>
    </TestProvider>
  );
}

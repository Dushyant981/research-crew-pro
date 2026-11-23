import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Starfield from './Starfield.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <>
    <Starfield />
    <App />
  </>
);

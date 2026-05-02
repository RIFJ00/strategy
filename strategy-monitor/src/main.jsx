import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Reactの描画エンジンを使って、App.jsx の内容を画面の 'root' 部分に反映させます
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// Reuse the existing CSS from client folder (no copy needed)
import '../../../client/src/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)

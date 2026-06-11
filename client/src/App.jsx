import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Navbar from './components/Navbar'
import Home from './pages/Home'
import Login from './pages/Login'

function AppContent() {
    const { appAuthenticated, loading } = useAuth()

    if (loading && !appAuthenticated) {
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100vh',
                width: '100vw',
                background: 'linear-gradient(135deg, #09090e 0%, #141424 50%, #0d0d17 100%)',
                color: '#ffffff'
            }}>
                <div className="loading-spinner" style={{
                    width: 40,
                    height: 40,
                    border: '3px solid rgba(255,255,255,0.1)',
                    borderTop: '3px solid #A142F4',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                }} />
            </div>
        )
    }

    if (!appAuthenticated) {
        return <Login />
    }

    return (
        <Router>
            <Navbar />
            <Routes>
                <Route path="/" element={<Home />} />
            </Routes>
        </Router>
    )
}

function App() {
    return (
        <AuthProvider>
            <AppContent />
        </AuthProvider>
    )
}

export default App

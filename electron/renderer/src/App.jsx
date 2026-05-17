import { HashRouter as Router, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import Navbar from './components/Navbar'
import Home from './pages/Home'

// HashRouter is used instead of BrowserRouter because Electron loads
// from file:// and cannot handle path-based routing without a server.
function App() {
    return (
        <AuthProvider>
            <Router>
                <Navbar />
                <Routes>
                    <Route path="/" element={<Home />} />
                </Routes>
            </Router>
        </AuthProvider>
    )
}

export default App

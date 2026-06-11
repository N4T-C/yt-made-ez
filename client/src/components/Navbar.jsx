import { motion } from 'framer-motion'
import { useAuth } from '../context/AuthContext'
import { FaGoogle } from 'react-icons/fa'

export default function Navbar() {
    const { user, isAuthenticated, logout, login, appUser, logoutFromApp } = useAuth()

    return (
        <nav className="navbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 32px' }}>
            <a className="navbar-logo" href="/" style={{ textDecoration: 'none' }}>
                <div className="navbar-logo-icon">▶</div>
                <span>YT <span style={{ color: 'var(--red)' }}>Studio</span></span>
            </a>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {/* Google OAuth (YouTube connection status) */}
                {isAuthenticated && user ? (
                    <div className="navbar-profile" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: 'rgba(52, 168, 83, 0.1)', border: '1px solid rgba(52, 168, 83, 0.25)', borderRadius: 20 }}>
                        <img
                            className="navbar-avatar"
                            src={user.picture}
                            alt={user.name}
                            referrerPolicy="no-referrer"
                            style={{ width: 22, height: 22, borderRadius: '50%' }}
                        />
                        <span className="navbar-username" style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.85)' }}>YT Connected</span>
                        <button
                            onClick={logout}
                            style={{ background: 'none', border: 'none', color: '#EA4335', fontSize: 11, cursor: 'pointer', marginLeft: 4, textDecoration: 'underline', padding: 0 }}
                            title="Disconnect YouTube Channel"
                        >
                            Disconnect
                        </button>
                    </div>
                ) : (
                    <motion.button
                        className="google-signin-btn"
                        onClick={login}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', fontSize: 12.5, background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.8)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, cursor: 'pointer' }}
                        whileHover={{ scale: 1.03, background: 'rgba(255,255,255,0.08)' }}
                        whileTap={{ scale: 0.97 }}
                    >
                        <FaGoogle size={11} style={{ color: '#4285F4' }} /> Connect YouTube
                    </motion.button>
                )}

                {/* App Auth status & Logout */}
                {appUser && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Welcome, <strong>{appUser.username}</strong></span>
                        <motion.button
                            className="btn-secondary navbar-logout"
                            onClick={logoutFromApp}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.96 }}
                            style={{ padding: '6px 14px', fontSize: 12.5, borderRadius: 20 }}
                        >
                            Logout
                        </motion.button>
                    </div>
                )}
            </div>

            <div className="navbar-accent" />
        </nav>
    )
}

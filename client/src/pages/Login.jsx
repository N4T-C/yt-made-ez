import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '../context/AuthContext'
import { FaUser, FaLock, FaCheckCircle, FaExclamationCircle } from 'react-icons/fa'

export default function Login() {
    const { loginToApp } = useAuth()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [success, setSuccess] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!username.trim() || !password.trim()) {
            setError('Please fill in all fields.')
            return
        }

        setError('')
        setLoading(true)

        try {
            await loginToApp(username, password)
            setSuccess(true)
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Login failed. Please try again.')
            setLoading(false)
        }
    }

    return (
        <div className="login-page-container" style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            width: '100vw',
            background: 'linear-gradient(135deg, #09090e 0%, #141424 50%, #0d0d17 100%)',
            position: 'relative',
            overflow: 'hidden',
            fontFamily: "'Outfit', sans-serif"
        }}>
            {/* Background glowing blobs */}
            <div className="hero-orbs" style={{ pointerEvents: 'none' }}>
                <div className="orb orb-1" style={{ top: '20%', left: '15%', background: 'radial-gradient(circle, rgba(161, 66, 244, 0.25) 0%, transparent 70%)', width: 400, height: 400 }} />
                <div className="orb orb-2" style={{ bottom: '20%', right: '15%', background: 'radial-gradient(circle, rgba(66, 133, 244, 0.2) 0%, transparent 70%)', width: 500, height: 500 }} />
            </div>

            <motion.div
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="login-card"
                style={{
                    background: 'rgba(25, 25, 40, 0.55)',
                    backdropFilter: 'blur(20px)',
                    webkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 24,
                    padding: '40px 48px',
                    width: '100%',
                    maxWidth: 420,
                    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
                    zIndex: 10,
                    position: 'relative'
                }}
            >
                {/* Glowing ring animation on card hover/focus */}
                <div className="login-card-glow" style={{
                    position: 'absolute',
                    top: -1, left: -1, right: -1, bottom: -1,
                    borderRadius: 24,
                    background: 'linear-gradient(135deg, rgba(161, 66, 244, 0.3), rgba(66, 133, 244, 0.3))',
                    zIndex: -1,
                    opacity: 0.2,
                    pointerEvents: 'none'
                }} />

                <div style={{ textAlign: 'center', marginBottom: 32 }}>
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 64,
                        height: 64,
                        borderRadius: 16,
                        background: 'linear-gradient(135deg, #A142F4, #4285F4)',
                        color: '#ffffff',
                        fontSize: 28,
                        fontWeight: 800,
                        marginBottom: 16,
                        boxShadow: '0 8px 20px rgba(161, 66, 244, 0.4)'
                    }}>
                        ▶
                    </div>
                    <h2 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px 0', color: '#ffffff' }}>
                        YT <span style={{ background: 'linear-gradient(90deg, #A142F4, #4285F4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Studio</span>
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>
                        Enter credentials to access dashboard tools
                    </p>
                </div>

                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label className="form-label" style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500 }}>
                            Username
                        </label>
                        <div style={{ position: 'relative' }}>
                            <FaUser style={{
                                position: 'absolute',
                                left: 16,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                color: 'rgba(255, 255, 255, 0.35)',
                                fontSize: 14
                            }} />
                            <input
                                className="form-input"
                                type="text"
                                placeholder="Username"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                style={{ paddingLeft: 44, background: 'rgba(0, 0, 0, 0.2)' }}
                                disabled={loading || success}
                                autoFocus
                            />
                        </div>
                    </div>

                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label className="form-label" style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500 }}>
                            Password
                        </label>
                        <div style={{ position: 'relative' }}>
                            <FaLock style={{
                                position: 'absolute',
                                left: 16,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                color: 'rgba(255, 255, 255, 0.35)',
                                fontSize: 14
                            }} />
                            <input
                                className="form-input"
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                style={{ paddingLeft: 44, background: 'rgba(0, 0, 0, 0.2)' }}
                                disabled={loading || success}
                            />
                        </div>
                    </div>

                    <AnimatePresence mode="wait">
                        {error && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    background: 'rgba(234, 67, 53, 0.08)',
                                    border: '1px solid rgba(234, 67, 53, 0.25)',
                                    borderRadius: 12,
                                    padding: '10px 14px',
                                    fontSize: 13,
                                    color: '#EA4335',
                                    lineHeight: 1.4
                                }}
                            >
                                <FaExclamationCircle style={{ flexShrink: 0 }} />
                                <span>{error}</span>
                            </motion.div>
                        )}
                        {success && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    background: 'rgba(52, 168, 83, 0.08)',
                                    border: '1px solid rgba(52, 168, 83, 0.25)',
                                    borderRadius: 12,
                                    padding: '10px 14px',
                                    fontSize: 13,
                                    color: '#34A853',
                                    lineHeight: 1.4
                                }}
                            >
                                <FaCheckCircle style={{ flexShrink: 0 }} />
                                <span>Login successful! Opening dashboard...</span>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <button
                        className="btn-primary"
                        type="submit"
                        disabled={loading || success}
                        style={{
                            background: 'linear-gradient(135deg, #A142F4, #4285F4)',
                            fontWeight: 700,
                            padding: '14px',
                            borderRadius: 12,
                            marginTop: 10,
                            cursor: (loading || success) ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {loading ? 'Verifying...' : 'Sign In'}
                    </button>
                </form>
            </motion.div>
        </div>
    )
}

/**
 * AuthContext — Electron version
 *
 * Replaces Firebase sign-in with a native Google OAuth flow:
 *  1. User clicks "Sign in" → renderer calls electronAPI.openExternal(authUrl)
 *  2. System browser opens Google consent screen
 *  3. Google redirects to yt-made-ez://oauth2callback?code=...
 *  4. Electron main.js catches the URI, exchanges code for tokens, sends user info
 *  5. This context receives { tokens, user } via the 'auth:tokensReceived' IPC event
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const AuthContext = createContext(null)

const AUTH_TOKENS_KEY = 'authTokens'
const AUTH_USER_KEY   = 'authUser'

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY)) } catch { return null }
    })
    const [tokens, setTokens] = useState(() => {
        try { return JSON.parse(localStorage.getItem(AUTH_TOKENS_KEY)) } catch { return null }
    })
    const [loading, setLoading] = useState(false)

    // Listen for OAuth tokens pushed from main process
    useEffect(() => {
        const unsub = window.electronAPI.onAuthTokens(({ tokens: t, user: u, error }) => {
            if (error) {
                console.error('OAuth error:', error)
                setLoading(false)
                return
            }
            if (t) {
                setTokens(t)
                localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(t))
            }
            if (u) {
                setUser(u)
                localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u))
            }
            setLoading(false)
        })
        return unsub
    }, [])

    const login = useCallback(async () => {
        setLoading(true)
        try {
            const { url } = await window.electronAPI.getAuthUrl()
            // Opens Google sign-in in system browser; callback comes back via IPC
            await window.electronAPI.openExternal(url)
        } catch (err) {
            console.error('Login error:', err)
            setLoading(false)
        }
    }, [])

    const logout = useCallback(() => {
        setUser(null)
        setTokens(null)
        localStorage.removeItem(AUTH_TOKENS_KEY)
        localStorage.removeItem(AUTH_USER_KEY)
    }, [])

    return (
        <AuthContext.Provider value={{
            user,
            tokens,
            isAuthenticated: !!user && !!tokens,
            loading,
            login,
            logout,
        }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider } from 'firebase/auth'
import { auth, googleProvider } from '../firebase'
import axios from 'axios'

const AuthContext = createContext(null)

const AUTH_TOKENS_KEY = 'authTokens'
const APP_USER_KEY = 'appUser'

export function AuthProvider({ children }) {
    // Google OAuth state (for YouTube uploads)
    const [user, setUser] = useState(null)
    const [tokens, setTokens] = useState(() => {
        try {
            const raw = localStorage.getItem(AUTH_TOKENS_KEY)
            return raw ? JSON.parse(raw) : null
        } catch { return null }
    })
    const [loading, setLoading] = useState(true)

    // App Session state (username/password login)
    const [appUser, setAppUser] = useState(() => {
        try {
            const raw = localStorage.getItem(APP_USER_KEY)
            return raw ? JSON.parse(raw) : null
        } catch { return null }
    })

    // Listen to Firebase auth state changes (Google OAuth)
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (firebaseUser) => {
            if (firebaseUser) {
                setUser({
                    name: firebaseUser.displayName,
                    email: firebaseUser.email,
                    picture: firebaseUser.photoURL,
                })
            } else {
                setUser(null)
                setTokens(null)
                localStorage.removeItem(AUTH_TOKENS_KEY)
            }
            setLoading(false)
        })
        return unsub
    }, [])

    const login = useCallback(async () => {
        try {
            const result = await signInWithPopup(auth, googleProvider)
            // Extract the Google OAuth access token from the popup result
            const credential = GoogleAuthProvider.credentialFromResult(result)
            const accessToken = credential?.accessToken
            if (accessToken) {
                const newTokens = { access_token: accessToken }
                setTokens(newTokens)
                localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(newTokens))
            }
        } catch (err) {
            console.error('Firebase sign-in error:', err)
        }
    }, [])

    const logout = useCallback(async () => {
        await signOut(auth)
        setUser(null)
        setTokens(null)
        localStorage.removeItem(AUTH_TOKENS_KEY)
    }, [])

    // App credential authentication
    const loginToApp = useCallback(async (username, password) => {
        const res = await axios.post('/api/auth/login', { username, password })
        if (res.data && res.data.success) {
            const userObj = res.data.user
            setAppUser(userObj)
            localStorage.setItem(APP_USER_KEY, JSON.stringify(userObj))
            return { success: true }
        } else {
            throw new Error(res.data.error || 'Login failed')
        }
    }, [])

    const logoutFromApp = useCallback(async () => {
        setAppUser(null)
        localStorage.removeItem(APP_USER_KEY)
        try {
            await logout()
        } catch {}
    }, [logout])

    return (
        <AuthContext.Provider value={{
            // Google auth (YouTube upload)
            user,
            tokens,
            isAuthenticated: !!user && !!tokens,
            loading,
            login,
            logout,

            // App credentials auth
            appUser,
            appAuthenticated: !!appUser,
            loginToApp,
            logoutFromApp,
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

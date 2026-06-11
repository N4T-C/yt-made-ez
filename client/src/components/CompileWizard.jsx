import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    FaYoutube, FaTimes, FaArrowRight, FaArrowLeft,
    FaCheckCircle, FaUpload, FaExclamationCircle, FaExternalLinkAlt, FaCheck, FaUndo, FaPlus, FaMinus, FaMagic, FaGoogle
} from 'react-icons/fa'
import { io } from 'socket.io-client'
import axios from 'axios'
import LoadingAnimation from './LoadingAnimation'
import { useAuth } from '../context/AuthContext'

const API_URL = '/api'
const POLL_INTERVAL = 2000
const WIZARD_STATE_KEY = 'compileWizardState'

const STEPS = [
    { label: 'Clip Details', icon: '📎' },
    { label: 'Processing', icon: '⚙️' },
    { label: 'Preview', icon: '🎬' },
    { label: 'YT Details', icon: '📋' },
    { label: 'Upload', icon: '🚀' },
]

const stepVariants = {
    enter: (dir) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
    center: { x: 0, opacity: 1, transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } },
    exit: (dir) => ({ x: dir > 0 ? -60 : 60, opacity: 0, transition: { duration: 0.2 } }),
}

function SavedIndicator({ show }) {
    if (!show) return null
    return <span className="save-indicator" key={Date.now()}><FaCheck /> Saved</span>
}

export default function CompileWizard({ onClose, ytDefaults }) {
    const { tokens, isAuthenticated, login } = useAuth()
    const savedRef = useRef(null)
    try {
        const raw = localStorage.getItem(WIZARD_STATE_KEY)
        if (raw) savedRef.current = JSON.parse(raw)
    } catch { /* ignore */ }
    const saved = savedRef.current

    const [step, setStep] = useState(() => {
        if (!saved) return 0
        if (saved.step === 1) return 0
        return saved.step ?? 0
    })
    const [direction, setDirection] = useState(1)
    const [links, setLinks] = useState(saved?.links ?? [''])

    // Trimming configs
    const [limitTotalDuration, setLimitTotalDuration] = useState(saved?.limitTotalDuration ?? false)
    const [trimIndividualClips, setTrimIndividualClips] = useState(saved?.trimIndividualClips ?? false)
    const [clipTrimLimit, setClipTrimLimit] = useState(saved?.clipTrimLimit ?? 15)

    const [jobId, setJobId] = useState(saved?.jobId ?? null)
    const [jobStatus, setJobStatus] = useState(() => {
        if (saved?.step >= 2 && saved?.jobId) return { status: 'ready', progress: 100, message: '🎉 Video ready!' }
        return { status: 'idle', progress: 0, message: 'Starting...' }
    })
    const pollRef = useRef(null)
    const socketRef = useRef(null)

    const [meta, setMeta] = useState(() => {
        const base = {
            title: '',
            description: '',
            tags: '',
            privacyStatus: 'private',
            categoryId: '22',
            madeForKids: false,
            language: 'en',
            defaultAudioLanguage: 'en',
            recordingDate: new Date().toISOString().split('T')[0],
            license: 'youtube',
            embeddable: true,
            publicStatsViewable: true,
            notifySubscribers: true,
        }
        if (saved?.meta) return { ...base, ...saved.meta, recordingDate: base.recordingDate }
        if (ytDefaults) {
            const processedDefaults = { ...ytDefaults }
            if (processedDefaults.title) processedDefaults.title = processedDefaults.title.replace(/{title}/g, 'Clip Compilation')
            if (processedDefaults.description) processedDefaults.description = processedDefaults.description.replace(/{title}/g, 'Clip Compilation')
            return { ...base, ...processedDefaults, recordingDate: base.recordingDate }
        }
        return base
    })

    const [uploadStatus, setUploadStatus] = useState(null)
    const [uploadError, setUploadError] = useState('')
    const [youtubeVideoId, setYoutubeVideoId] = useState(null)
    const [shareStatus, setShareStatus] = useState(null)
    const [shareUrl, setShareUrl] = useState('')
    const [shareError, setShareError] = useState('')
    const [savedFields, setSavedFields] = useState({})
    const [aiAutofillLoading, setAiAutofillLoading] = useState(false)
    const [aiAutofillSuccess, setAiAutofillSuccess] = useState(false)

    const showSaved = useCallback((fieldId) => {
        setSavedFields(prev => ({ ...prev, [fieldId]: true }))
        setTimeout(() => setSavedFields(prev => ({ ...prev, [fieldId]: false })), 1800)
    }, [])

    const persistRef = useRef(true)

    useEffect(() => {
        if (saved?.step >= 2 && saved?.jobId) {
            axios.get(`${API_URL}/video/status/${saved.jobId}`)
                .then(r => { if (r.data.status === 'ready') setJobStatus({ status: 'ready', progress: 100, message: '🎉 Video ready!' }); else setStep(0) })
                .catch(() => { setStep(0); setJobId(null) })
        }
    }, [])

    const saveTimerRef = useRef(null)
    useEffect(() => {
        if (!persistRef.current) return
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
            localStorage.setItem(WIZARD_STATE_KEY, JSON.stringify({
                step, links, limitTotalDuration, trimIndividualClips, clipTrimLimit, meta, jobId
            }))
        }, 300)
        return () => clearTimeout(saveTimerRef.current)
    }, [step, links, limitTotalDuration, trimIndividualClips, clipTrimLimit, meta, jobId])

    useEffect(() => {
        if (!jobId) return
        const applyUpdate = (data) => {
            setJobStatus(prev => {
                if (data.progress < prev.progress && data.status === prev.status) return prev
                return data
            })
            if (data.status === 'ready') { stopPolling(); setTimeout(() => { setDirection(1); setStep(2) }, 900) }
            if (data.status === 'error') stopPolling()
        }
        const startPolling = () => { pollRef.current = setInterval(async () => { try { const res = await axios.get(`${API_URL}/video/status/${jobId}`); applyUpdate(res.data) } catch {} }, POLL_INTERVAL) }
        const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null } }
        try { const socket = io(import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin, { transports: ['websocket', 'polling'] }); socketRef.current = socket; socket.on(`job:${jobId}`, applyUpdate) } catch {}
        startPolling()
        axios.get(`${API_URL}/video/status/${jobId}`).then(r => applyUpdate(r.data)).catch(() => {})
        return stopPolling
    }, [jobId])

    const go = useCallback((dir) => { setDirection(dir); setStep(s => s + dir) }, [])

    const startProcessing = async () => {
        go(1)
        setJobStatus({ status: 'processing', progress: 0, message: 'Submitting job...' })
        setShareStatus(null); setShareUrl(''); setShareError('')
        try {
            const res = await axios.post(`${API_URL}/video/process-compile`, {
                links: links.map(l => l.trim()),
                limitTotalDuration,
                trimIndividualClips,
                clipTrimLimit: Number(clipTrimLimit)
            })
            setJobId(res.data.jobId)
        } catch (err) {
            setJobStatus({ status: 'error', progress: 0, message: err.response?.data?.error || err.message || 'Failed to start processing' })
        }
    }

    const handleShare = async () => {
        setShareStatus('uploading'); setShareError(''); setShareUrl('')
        try { const res = await axios.post(`${API_URL}/video/share`, { jobId, deleteAfter: false }); setShareUrl(res.data.url); setShareStatus('success') }
        catch (err) { setShareStatus('error'); setShareError(err.response?.data?.error || err.message) }
    }

    const handleUpload = async () => {
        setUploadStatus('uploading'); setUploadError('')
        try {
            const res = await axios.post(`${API_URL}/video/upload`, { jobId, metadata: { ...meta, tags: meta.tags.split(',').map(t => t.trim()).filter(Boolean) }, tokens })
            setYoutubeVideoId(res.data.videoId); setUploadStatus('success')
            persistRef.current = false; localStorage.removeItem(WIZARD_STATE_KEY)
        } catch (err) { setUploadStatus('error'); setUploadError(err.response?.data?.error || err.message) }
    }

    const handleClose = useCallback(() => {
        if (uploadStatus === 'success') { persistRef.current = false; localStorage.removeItem(WIZARD_STATE_KEY) }
        onClose()
    }, [uploadStatus, onClose])

    const handleStartOver = useCallback(() => {
        persistRef.current = false; localStorage.removeItem(WIZARD_STATE_KEY)
        if (jobId) axios.post(`${API_URL}/video/cleanup`).catch(() => {})
        setStep(0); setDirection(-1); setLinks(['']); setJobId(null); setLimitTotalDuration(false); setTrimIndividualClips(false); setClipTrimLimit(15)
        setJobStatus({ status: 'idle', progress: 0, message: 'Starting...' })
        setMeta({
            title: '', description: '', tags: '', privacyStatus: 'private',
            categoryId: '22', madeForKids: false, language: 'en',
            defaultAudioLanguage: 'en', recordingDate: new Date().toISOString().split('T')[0],
            license: 'youtube', embeddable: true, publicStatsViewable: true, notifySubscribers: true,
        })
        setUploadStatus(null); setUploadError(''); setYoutubeVideoId(null); setShareStatus(null); setShareUrl(''); setShareError('')
        setTimeout(() => { persistRef.current = true }, 100)
    }, [jobId])

    const triggerAiAutofill = async () => {
        setAiAutofillLoading(true)
        setAiAutofillSuccess(false)
        try {
            const res = await axios.post(`${API_URL}/video/suggest-metadata`, {
                videoTitle: 'Compilation',
                captions: [],
                category: meta.categoryId
            })
            setMeta(prev => ({
                ...prev,
                title: res.data.title || prev.title,
                description: res.data.description || prev.description,
                tags: res.data.tags || prev.tags
            }))
            setAiAutofillSuccess(true)
            setTimeout(() => setAiAutofillSuccess(false), 2000)
        } catch (err) {
            console.error('AI autofill failed:', err)
        } finally {
            setAiAutofillLoading(false)
        }
    }

    const addLink = () => {
        setLinks(prev => [...prev, ''])
    }

    const removeLink = (i) => {
        if (links.length <= 1) return
        setLinks(prev => prev.filter((_, idx) => idx !== i))
    }

    const updateLink = (i, v) => setLinks(ls => ls.map((l, j) => j === i ? v : l))
    const updateMeta = (k, v) => setMeta(m => ({ ...m, [k]: v }))
    const handleBlur = useCallback((fieldId, value) => { if (value && String(value).trim()) showSaved(fieldId) }, [showSaved])

    // Validation constraints
    const isClipLimitValid = !trimIndividualClips || (Number(clipTrimLimit) >= 1 && Number(clipTrimLimit) <= 60)
    const valid0 = links.length > 0 && links.every(l => l.trim()) && isClipLimitValid

    return (
        <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={e => e.target === e.currentTarget && handleClose()}>
            <motion.div className="modal-content" initial={{ opacity: 0, scale: 0.88, y: 40 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.88, y: 40 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
                <button className="modal-close" onClick={handleClose}><FaTimes /></button>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <h2 className="modal-title" style={{ marginBottom: 0 }}>
                        <span style={{ background: 'linear-gradient(90deg,#A142F4,#4285F4,#34A853)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                            Compile Clips or Memes
                        </span>
                    </h2>
                    {step > 0 && uploadStatus !== 'success' && (
                        <button className="start-over-btn" onClick={handleStartOver}><FaUndo style={{ fontSize: 10, marginRight: 4 }} /> Start Over</button>
                    )}
                </div>
                <p className="modal-subtitle">{STEPS[step]?.icon} {STEPS[step]?.label} — Step {step + 1} of {STEPS.length}</p>

                <div className="steps-indicator">
                    {STEPS.map((s, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: i < STEPS.length - 1 ? 1 : 'none' }}>
                            <div className={`step-dot ${i === step ? 'active' : ''} ${i < step ? 'completed' : ''}`} />
                            {i < STEPS.length - 1 && <div className="step-line" />}
                        </div>
                    ))}
                </div>

                <AnimatePresence mode="wait" custom={direction}>
                    {/* Step 0: Links & Trimming Setup */}
                    {step === 0 && (
                        <motion.div key="s0" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                <label className="form-label" style={{ marginBottom: 0 }}>▶️ Video Links to Compile</label>
                                <button className="caption-mode-btn" type="button" onClick={addLink} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'rgba(66, 133, 244, 0.1)', color: '#4285F4', borderColor: 'rgba(66, 133, 244, 0.2)' }}>
                                    <FaPlus size={10} /> Add Link
                                </button>
                            </div>

                            <div className="links-form" style={{ marginBottom: 20, maxHeight: 220, overflowY: 'auto', paddingRight: 6 }}>
                                {links.map((link, i) => (
                                    <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: i < links.length - 1 ? 12 : 0, background: 'rgba(255,255,255,0.02)', padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.04)' }}>
                                        <div className="link-input-group">
                                            <div className="link-number" style={{ background: 'rgba(161, 66, 244, 0.15)', color: '#A142F4', border: '1px solid rgba(161, 66, 244, 0.3)' }}>{i + 1}</div>
                                            <input className="form-input" type="url" placeholder={`Insert video link ${i + 1}`} value={link} onChange={e => updateLink(i, e.target.value)} onBlur={() => handleBlur(`link-${i}`, link)} style={{ flex: 1 }} />
                                            {links.length > 1 && (
                                                <button className="btn-secondary" type="button" onClick={() => removeLink(i)} style={{ padding: '11px 14px', background: 'rgba(234, 67, 53, 0.12)', color: '#EA4335', borderColor: 'rgba(234, 67, 53, 0.25)', minWidth: 38 }}>
                                                    <FaMinus size={11} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Duration & Trimming Settings */}
                            <label className="form-label" style={{ marginBottom: 12, display: 'block' }}>✂️ Duration & Trimming Constraints</label>
                            <div style={{ background: 'var(--surface)', padding: 16, borderRadius: 12, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                                    <input type="checkbox" checked={limitTotalDuration} onChange={e => setLimitTotalDuration(e.target.checked)} style={{ width: 18, height: 18, cursor: 'pointer' }} />
                                    Limit total output video to under 1 minute (57s)
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                                    <input type="checkbox" checked={trimIndividualClips} onChange={e => setTrimIndividualClips(e.target.checked)} style={{ width: 18, height: 18, cursor: 'pointer' }} />
                                    Trim individual clips that are too long
                                </label>

                                <AnimatePresence>
                                    {trimIndividualClips && (
                                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden', paddingLeft: 28 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>Limit clip duration to:</span>
                                                <input className="form-input" type="number" min={1} max={60} value={clipTrimLimit} onChange={e => setClipTrimLimit(e.target.value)} style={{ width: 80, padding: '6px 10px' }} />
                                                <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>seconds</span>
                                            </div>
                                            {!isClipLimitValid && (
                                                <p style={{ color: '#EA4335', fontSize: 11.5, marginTop: 6, margin: 0 }}>⚠️ Limit must be strictly between 1 and 60 seconds.</p>
                                            )}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            <div className="actions-row">
                                <button className="btn-secondary" onClick={handleClose}>Cancel</button>
                                <button className="btn-primary" onClick={startProcessing} disabled={!valid0} id="process-compile-btn" style={{ background: 'linear-gradient(135deg, #A142F4, #8b25e2)' }}>Start Processing <FaArrowRight /></button>
                            </div>
                        </motion.div>
                    )}

                    {/* Step 1: Processing */}
                    {step === 1 && (
                        <motion.div key="s1" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <LoadingAnimation progress={jobStatus.progress} message={jobStatus.message || 'Starting pipeline...'} isError={jobStatus.status === 'error'} />
                            {jobStatus.status === 'error' && (
                                <div style={{ marginTop: 16, textAlign: 'center' }}>
                                    <div style={{ background: 'rgba(234,67,53,0.08)', border: '1px solid rgba(234,67,53,0.3)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#EA4335', textAlign: 'left', lineHeight: 1.6, maxHeight: 120, overflow: 'auto' }}>{jobStatus.message}</div>
                                    <button className="btn-secondary" onClick={() => { setStep(0); setDirection(-1); setJobId(null) }}><FaArrowLeft /> Go Back & Retry</button>
                                </div>
                            )}
                        </motion.div>
                    )}

                    {/* Step 2: Preview */}
                    {step === 2 && (
                        <motion.div key="s2" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14 }}>🎬 Your compiled video is ready! Watch it below, then click <strong>Next</strong> to set up YouTube upload details.</p>
                            <video key={jobId} src={`/api/video/download/${jobId}`} controls style={{ width: '100%', borderRadius: 12, background: '#000', marginBottom: 14, maxHeight: 380 }} />
                            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 24, flexWrap: 'wrap' }}>
                                <a href={`/api/video/download/${jobId}`} download={`compile_video_${Date.now()}.mp4`} className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7 }}>⬇️ Download Video</a>
                                <button className="btn-secondary" onClick={handleShare} disabled={shareStatus === 'uploading'} type="button">🔗 Share via Filebin</button>
                            </div>
                            {shareStatus === 'uploading' && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: 13, marginBottom: 12 }}>Uploading to Filebin...</p>}
                            {shareStatus === 'error' && <p style={{ color: '#EA4335', textAlign: 'center', fontSize: 13, marginBottom: 12 }}>{shareError || 'Filebin upload failed'}</p>}
                            {shareStatus === 'success' && shareUrl && <div className="share-link"><span className="share-label">Filebin URL</span><a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a></div>}
                            <div className="actions-row">
                                <button className="btn-secondary" onClick={() => { setStep(0); setDirection(-1); }}><FaArrowLeft /> Back</button>
                                <button className="btn-primary" onClick={() => go(1)} style={{ background: 'linear-gradient(135deg, #A142F4, #8b25e2)' }}>Next: YT Details <FaArrowRight /></button>
                            </div>
                        </motion.div>
                    )}

                    {/* Step 3: YouTube Upload Metadata */}
                    {step === 3 && (
                        <motion.div key="s3" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                                <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>✅ Video processed! Now fill in the YouTube upload details.</p>
                                <button className="caption-mode-btn" type="button" onClick={triggerAiAutofill} disabled={aiAutofillLoading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: 'rgba(161, 66, 244, 0.15)', color: '#A142F4', borderColor: 'rgba(161, 66, 244, 0.3)' }}>
                                    <FaMagic size={11} className={aiAutofillLoading ? 'spin-animation' : ''} />
                                    {aiAutofillLoading ? 'AI Generating...' : aiAutofillSuccess ? 'Details Copied! ✨' : '✨ AI Autofill Details'}
                                </button>
                            </div>

                            <div className="metadata-form">
                                <div className="form-group full-width">
                                    <label className="form-label">Video Title <SavedIndicator show={savedFields['yt-title']} /></label>
                                    <input className="form-input" type="text" placeholder="My Compiled Shorts Video #Shorts" value={meta.title} onChange={e => updateMeta('title', e.target.value)} onBlur={() => handleBlur('yt-title', meta.title)} maxLength={100} id="yt-compile-title" />
                                    <span className="form-hint">Max 100 chars. Add #Shorts for short-form content.</span>
                                </div>
                                <div className="form-group full-width">
                                    <label className="form-label">Description <SavedIndicator show={savedFields['yt-desc']} /></label>
                                    <textarea className="form-input" placeholder="Describe your video... use keywords for SEO" value={meta.description} onChange={e => updateMeta('description', e.target.value)} onBlur={() => handleBlur('yt-desc', meta.description)} maxLength={5000} rows={3} id="yt-compile-desc" />
                                    <span className="form-hint">Max 5,000 characters.</span>
                                </div>
                                <div className="form-group full-width">
                                    <label className="form-label">Tags <SavedIndicator show={savedFields['yt-tags']} /></label>
                                    <input className="form-input" type="text" placeholder="viral, memes, compilation, shorts" value={meta.tags} onChange={e => updateMeta('tags', e.target.value)} onBlur={() => handleBlur('yt-tags', meta.tags)} id="yt-compile-tags" />
                                    <span className="form-hint">Comma-separated. e.g., "memes, viral, compilation"</span>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Privacy</label>
                                    <select className="form-select" value={meta.privacyStatus} onChange={e => updateMeta('privacyStatus', e.target.value)} id="yt-compile-privacy">
                                        <option value="public">Public</option><option value="private">Private</option><option value="unlisted">Unlisted</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Category</label>
                                    <select className="form-select" value={meta.categoryId} onChange={e => updateMeta('categoryId', e.target.value)} id="yt-compile-category">
                                        <option value="23">Comedy</option><option value="24">Entertainment</option><option value="15">Pets &amp; Animals</option><option value="22">People &amp; Blogs</option><option value="20">Gaming</option><option value="17">Sports</option><option value="10">Music</option><option value="27">Education</option><option value="28">Science &amp; Technology</option><option value="1">Film &amp; Animation</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Made for Kids</label>
                                    <select className="form-select" value={String(meta.madeForKids)} onChange={e => updateMeta('madeForKids', e.target.value === 'true')} id="yt-compile-kids">
                                        <option value="false">No</option><option value="true">Yes</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Language</label>
                                    <select className="form-select" value={meta.language} onChange={e => updateMeta('language', e.target.value)} id="yt-compile-lang">
                                        <option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="pt">Portuguese</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Audio Language</label>
                                    <select className="form-select" value={meta.defaultAudioLanguage} onChange={e => updateMeta('defaultAudioLanguage', e.target.value)} id="yt-compile-audiolang">
                                        <option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="pt">Portuguese</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Recording Date</label>
                                    <input className="form-input" type="date" value={meta.recordingDate} onChange={e => updateMeta('recordingDate', e.target.value)} id="yt-compile-date" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">License</label>
                                    <select className="form-select" value={meta.license} onChange={e => updateMeta('license', e.target.value)} id="yt-compile-license">
                                        <option value="youtube">Standard YouTube</option><option value="creativeCommon">Creative Commons</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Embeddable</label>
                                    <select className="form-select" value={String(meta.embeddable)} onChange={e => updateMeta('embeddable', e.target.value === 'true')} id="yt-compile-embed">
                                        <option value="true">Yes</option><option value="false">No</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Public Stats</label>
                                    <select className="form-select" value={String(meta.publicStatsViewable)} onChange={e => updateMeta('publicStatsViewable', e.target.value === 'true')} id="yt-compile-stats">
                                        <option value="true">Visible</option><option value="false">Hidden</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Notify Subscribers</label>
                                    <select className="form-select" value={String(meta.notifySubscribers)} onChange={e => updateMeta('notifySubscribers', e.target.value === 'true')} id="yt-compile-notify">
                                        <option value="true">Yes</option><option value="false">No</option>
                                    </select>
                                </div>
                            </div>
                            <div className="actions-row" style={{ marginTop: 24 }}>
                                <button className="btn-secondary" onClick={() => go(-1)}><FaArrowLeft /> Back</button>
                                <button className="btn-primary" onClick={() => go(1)} id="to-upload-compile-btn" style={{ background: 'linear-gradient(135deg, #A142F4, #8b25e2)' }}>Continue to Upload <FaArrowRight /></button>
                            </div>
                        </motion.div>
                    )}

                    {/* Step 4: Upload */}
                    {step === 4 && (
                        <motion.div key="s4" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            {uploadStatus === 'success' ? (
                                <div className="success-container">
                                    <motion.div className="success-icon" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>🎉</motion.div>
                                    <h3 className="success-title">Upload Successful!</h3>
                                    <p className="success-subtitle">Your video compilation is now on YouTube.</p>
                                    {youtubeVideoId && <a href={`https://www.youtube.com/watch?v=${youtubeVideoId}`} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 12, background: 'linear-gradient(135deg, #A142F4, #8b25e2)' }}><FaExternalLinkAlt /> Watch on YouTube</a>}
                                    <br /><button className="btn-secondary" onClick={handleClose} style={{ marginTop: 8 }}>Done</button>
                                </div>
                            ) : uploadStatus === 'uploading' ? (
                                <LoadingAnimation progress={50} message="📤 Uploading to YouTube..." subMessage="This can take a few minutes." />
                            ) : (
                                <>
                                    <div style={{ textAlign: 'center', padding: '20px 0 28px' }}>
                                        {isAuthenticated ? (
                                            <>
                                                <FaCheckCircle style={{ color: '#34A853', fontSize: 52, marginBottom: 12 }} />
                                                <p style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Google Account Connected!</p>
                                                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 24 }}>Click Upload to publish your compiled video now.</p>
                                                <button className="btn-primary" onClick={handleUpload} style={{ background: 'linear-gradient(135deg, #A142F4, #8b25e2)' }}><FaUpload /> Upload to YouTube</button>
                                            </>
                                        ) : (
                                            <>
                                                <div style={{ fontSize: 48, marginBottom: 12 }}>🔐</div>
                                                <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 15 }}>Connect your Google/YouTube account to upload directly.</p>
                                                <button className="google-signin-btn" onClick={login} style={{ margin: '0 auto' }}>
                                                    <FaGoogle style={{ color: '#4285F4', marginRight: 8 }} /> Connect YouTube
                                                </button>
                                            </>
                                        )}
                                    </div>
                                    {uploadStatus === 'error' && (
                                        <div style={{ background: 'rgba(234,67,53,0.08)', border: '1px solid rgba(234,67,53,0.3)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#EA4335', lineHeight: 1.6 }}>
                                            <FaExclamationCircle style={{ marginRight: 8 }} />{uploadError || 'Upload failed. Please try again.'}
                                        </div>
                                    )}
                                    <div className="actions-row">
                                        <button className="btn-secondary" onClick={() => go(-1)} disabled={!!uploadStatus}><FaArrowLeft /> Back</button>
                                        {uploadStatus === 'error' && <button className="btn-secondary" onClick={() => { setUploadStatus(null); setUploadError('') }}>Retry</button>}
                                    </div>
                                </>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </motion.div>
    )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    FaInstagram, FaYoutube, FaTimes, FaArrowRight, FaArrowLeft,
    FaCheckCircle, FaUpload, FaExclamationCircle, FaExternalLinkAlt, FaCheck, FaUndo
} from 'react-icons/fa'
import LoadingAnimation from './LoadingAnimation'
import { useAuth } from '../context/AuthContext'

const WIZARD_STATE_KEY = 'rankingWizardState'

const STEPS = [
    { label: 'Video Info', icon: '📝' },
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

// Save indicator — shows green checkmark briefly on blur
function SavedIndicator({ show }) {
    if (!show) return null
    return (
        <span className="save-indicator" key={Date.now()}>
            <FaCheck /> Saved
        </span>
    )
}

export default function RankingWizard({ onClose, ytDefaults }) {
    const { tokens, isAuthenticated } = useAuth()
    
    const savedRef = useRef(null)
    try {
        const raw = localStorage.getItem(WIZARD_STATE_KEY)
        if (raw) savedRef.current = JSON.parse(raw)
    } catch { /* ignore corrupt data */ }
    const saved = savedRef.current

    const [step, setStep] = useState(() => {
        if (!saved) return 0
        if (saved.step === 1) return 0
        return saved.step ?? 0
    })
    const [direction, setDirection] = useState(1)

    // Step 1 inputs
    const [videoTitle, setVideoTitle] = useState(saved?.videoTitle ?? '')
    const [links, setLinks] = useState(saved?.links ?? ['', '', '', '', ''])
    const [captions, setCaptions] = useState(saved?.captions ?? ['', '', '', '', ''])
    const [captionMode, setCaptionMode] = useState(saved?.captionMode ?? 'manual')

    // Step 2 — job/processing
    const [jobId, setJobId] = useState(saved?.jobId ?? null)
    const [jobStatus, setJobStatus] = useState(() => {
        if (saved?.step >= 2 && saved?.jobId) return { status: 'ready', progress: 100, message: '🎉 Video ready!' }
        return { status: 'idle', progress: 0, message: 'Starting...' }
    })
    const [videoFilePath, setVideoFilePath] = useState(null)

    // Step 4 — YT metadata (initialized from saved → ytDefaults → base)
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
            if (processedDefaults.title) processedDefaults.title = processedDefaults.title.replace(/{title}/g, videoTitle || '')
            if (processedDefaults.description) processedDefaults.description = processedDefaults.description.replace(/{title}/g, videoTitle || '')
            return { ...base, ...processedDefaults, recordingDate: base.recordingDate }
        }
        return base
    })

    // Step 5 — upload
    const [uploadStatus, setUploadStatus] = useState(null)
    const [uploadError, setUploadError] = useState('')
    const [youtubeVideoId, setYoutubeVideoId] = useState(null)
    const [shareStatus, setShareStatus] = useState(null)
    const [shareUrl, setShareUrl] = useState('')
    const [shareError, setShareError] = useState('')

    // Track which fields have been "saved" (show green indicator on blur)
    const [savedFields, setSavedFields] = useState({})

    const showSaved = useCallback((fieldId) => {
        setSavedFields(prev => ({ ...prev, [fieldId]: true }))
        setTimeout(() => setSavedFields(prev => ({ ...prev, [fieldId]: false })), 1800)
    }, [])

    const persistRef = useRef(true)

    // ── Validate saved job on mount ──────────────────────────────────────────
    useEffect(() => {
        if (saved?.step >= 2 && saved?.jobId) {
            window.electronAPI.getJobStatus(saved.jobId)
                .then(r => {
                    if (r.status === 'ready') {
                        setJobStatus({ status: 'ready', progress: 100, message: '🎉 Video ready!' })
                        window.electronAPI.getVideoFilePath(saved.jobId).then(setVideoFilePath).catch(console.error)
                    } else {
                        setStep(0)
                    }
                })
                .catch(() => {
                    setStep(0)
                    setJobId(null)
                })
        }
    }, [])

    // ── Auto-save wizard state to localStorage on every change ─────────────────
    const saveTimerRef = useRef(null)
    useEffect(() => {
        if (!persistRef.current) return
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
            localStorage.setItem(WIZARD_STATE_KEY, JSON.stringify({
                step, videoTitle, links, captions, captionMode, meta, jobId,
            }))
        }, 300)
        return () => clearTimeout(saveTimerRef.current)
    }, [step, videoTitle, links, captions, captionMode, meta, jobId])

    // ── Dynamic template replacement ──────────────────────────────────────────
    useEffect(() => {
        if (step === 3 && ytDefaults) {
            setMeta(prev => {
                const newMeta = { ...prev }
                let changed = false
                if (newMeta.title.includes('{title}')) {
                    newMeta.title = newMeta.title.replace(/{title}/g, videoTitle || '')
                    changed = true
                }
                if (newMeta.description.includes('{title}')) {
                    newMeta.description = newMeta.description.replace(/{title}/g, videoTitle || '')
                    changed = true
                }
                return changed ? newMeta : prev
            })
        }
    }, [step, videoTitle, ytDefaults])

    // ── Listen for IPC job status updates ──────────────────────────────────────
    useEffect(() => {
        if (!jobId) return

        let unsub = window.electronAPI.onJobUpdate(jobId, (data) => {
            setJobStatus(prev => {
                if (data.progress < prev.progress && data.status === prev.status) return prev
                return data
            })

            if (data.status === 'ready') {
                if (data.outputFile) {
                    setVideoFilePath(data.outputFile)
                } else {
                    window.electronAPI.getVideoFilePath(jobId).then(setVideoFilePath).catch(console.error)
                }
                setTimeout(() => { setDirection(1); setStep(2) }, 900)
            }
        })

        // Immediate first check in case we missed events
        window.electronAPI.getJobStatus(jobId)
            .then(data => {
                setJobStatus(data)
                if (data.status === 'ready') {
                    window.electronAPI.getVideoFilePath(jobId).then(setVideoFilePath).catch(console.error)
                }
            })
            .catch(() => {})

        return () => unsub && unsub()
    }, [jobId])

    const go = useCallback((dir) => {
        setDirection(dir)
        setStep(s => s + dir)
    }, [])

    // ── Step 0 — start processing ─────────────────────────────────────────────
    const startProcessing = async () => {
        go(1)
        setJobStatus({ status: 'processing', progress: 0, message: 'Submitting job...' })
        setShareStatus(null)
        setShareUrl('')
        setShareError('')
        setVideoFilePath(null)
        try {
            const res = await window.electronAPI.processVideo({
                videoTitle: videoTitle.trim(),
                captions: captions.map(c => c.trim()),
                links: links.map(l => l.trim()),
                captionMode,
            })
            setJobId(res.jobId)
        } catch (err) {
            setJobStatus({
                status: 'error',
                progress: 0,
                message: err.message || 'Failed to start processing',
            })
        }
    }

    const handleShare = async () => {
        setShareStatus('uploading')
        setShareError('')
        setShareUrl('')
        try {
            const res = await window.electronAPI.shareVideo({ jobId, deleteAfter: false })
            setShareUrl(res.url)
            setShareStatus('success')
        } catch (err) {
            setShareStatus('error')
            setShareError(err.message)
        }
    }

    const handleDownload = async () => {
        if (!videoFilePath) return
        const defaultName = `${videoTitle.trim().replace(/[^a-z0-9]/gi, '_') || 'ranking_video'}.mp4`
        try {
            const { saved, savePath } = await window.electronAPI.downloadFile({
                filePath: videoFilePath,
                defaultName,
            })
            if (saved) {
                console.log('Saved to', savePath)
            }
        } catch (err) {
            console.error('Download failed:', err)
        }
    }

    // ── YouTube upload ────────────────────────────────────────────────────────
    const handleUpload = async () => {
        setUploadStatus('uploading')
        setUploadError('')
        try {
            const res = await window.electronAPI.uploadToYouTube({
                jobId,
                metadata: {
                    ...meta,
                    tags: meta.tags.split(',').map(t => t.trim()).filter(Boolean),
                },
                tokens,
            })
            setYoutubeVideoId(res.videoId)
            setUploadStatus('success')
            persistRef.current = false
            localStorage.removeItem(WIZARD_STATE_KEY)
        } catch (err) {
            setUploadStatus('error')
            setUploadError(err.message)
        }
    }

    const handleClose = useCallback(() => {
        if (uploadStatus === 'success') {
            persistRef.current = false
            localStorage.removeItem(WIZARD_STATE_KEY)
        }
        onClose()
    }, [uploadStatus, onClose])

    const handleStartOver = useCallback(() => {
        persistRef.current = false
        localStorage.removeItem(WIZARD_STATE_KEY)
        if (jobId) {
            window.electronAPI.cleanupVideos().catch(() => {})
        }
        setStep(0)
        setDirection(-1)
        setVideoTitle('')
        setLinks(['', '', '', '', ''])
        setCaptions(['', '', '', '', ''])
        setCaptionMode('manual')
        setJobId(null)
        setJobStatus({ status: 'idle', progress: 0, message: 'Starting...' })
        setVideoFilePath(null)
        setMeta({
            title: '', description: '', tags: '', privacyStatus: 'private',
            categoryId: '22', madeForKids: false, language: 'en',
            defaultAudioLanguage: 'en', recordingDate: new Date().toISOString().split('T')[0],
            license: 'youtube', embeddable: true, publicStatsViewable: true, notifySubscribers: true,
        })
        setUploadStatus(null)
        setUploadError('')
        setYoutubeVideoId(null)
        setShareStatus(null)
        setShareUrl('')
        setShareError('')
        setTimeout(() => { persistRef.current = true }, 100)
    }, [jobId])

    const valid1 = videoTitle.trim() &&
        links.every(l => l.trim()) &&
        (captionMode !== 'manual' || captions.every(c => c.trim()))

    const updateLink = (i, v) => setLinks(ls => ls.map((l, j) => j === i ? v : l))
    const updateCaption = (i, v) => setCaptions(cs => cs.map((c, j) => j === i ? v : c))
    const updateMeta = (k, v) => setMeta(m => ({ ...m, [k]: v }))

    const handleBlur = useCallback((fieldId, value) => {
        if (value && String(value).trim()) showSaved(fieldId)
    }, [showSaved])

    const linkColors = ['#EA4335', '#FBBC04', '#A142F4', '#34A853', '#4285F4']

    return (
        <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={e => e.target === e.currentTarget && handleClose()}>
            <motion.div className="modal-content" initial={{ opacity: 0, scale: 0.88, y: 40 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.88, y: 40 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
                <button className="modal-close" onClick={handleClose}><FaTimes /></button>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <h2 className="modal-title" style={{ marginBottom: 0 }}>
                        <span style={{ background: 'linear-gradient(90deg,#EA4335,#FBBC04,#A142F4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                            Create Ranking Video
                        </span>
                    </h2>
                    {step > 0 && uploadStatus !== 'success' && (
                        <button className="start-over-btn" onClick={handleStartOver}>
                            <FaUndo style={{ fontSize: 10, marginRight: 4 }} /> Start Over
                        </button>
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
                    {/* ── Step 0: Video Info ── */}
                    {step === 0 && (
                        <motion.div key="s0" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <div className="form-group" style={{ marginBottom: 20 }}>
                                <label className="form-label">📌 Video Title Overlay <SavedIndicator show={savedFields['videoTitle']} /></label>
                                <input className="form-input" type="text" placeholder="e.g., RANKING CUTEST KITTY MOMENTS" value={videoTitle} onChange={e => setVideoTitle(e.target.value)} onBlur={() => handleBlur('videoTitle', videoTitle)} maxLength={100} id="video-title-input" autoFocus />
                                <span className="form-hint">Overlaid on screen throughout the video</span>
                            </div>

                            <label className="form-label" style={{ marginBottom: 10, display: 'block' }}>▶️ YouTube / Instagram Links (all 5 required)</label>
                            <div className="links-form" style={{ marginBottom: 20 }}>
                                {links.map((link, i) => (
                                    <div className="link-input-group" key={i}>
                                        <div className="link-number" style={{ background: `${linkColors[i]}22`, color: linkColors[i], border: `1px solid ${linkColors[i]}44` }}>{i + 1}</div>
                                        <input className="form-input" type="url" placeholder={`Clip ${i + 1} link`} value={link} onChange={e => updateLink(i, e.target.value)} onBlur={() => handleBlur(`link-${i}`, link)} id={`link-${i}`} />
                                        <SavedIndicator show={savedFields[`link-${i}`]} />
                                    </div>
                                ))}
                            </div>

                            <label className="form-label" style={{ marginBottom: 10, display: 'block' }}>🧩 Caption Mode</label>
                            <div className="caption-mode">
                                {[{ id: 'manual', label: 'Manual' }, { id: 'random', label: 'Auto (Random)' }, { id: 'ai', label: 'Auto (Gemini)' }].map(opt => (
                                    <button key={opt.id} className={`caption-mode-btn ${captionMode === opt.id ? 'active' : ''}`} onClick={() => setCaptionMode(opt.id)} type="button">
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                            <span className="form-hint" style={{ display: 'block', marginBottom: 14 }}>
                                Auto (Gemini) requires `GEMINI_API_KEY` in electron/.env. Auto modes use best-effort captions.
                            </span>

                            <label className="form-label" style={{ marginBottom: 10, display: 'block' }}>💬 Ranking Captions (shown as overlay text)</label>
                            <div className="links-form">
                                {captions.map((cap, i) => (
                                    <div className="link-input-group" key={i}>
                                        <div className="link-number" style={{ background: `${linkColors[i]}22`, color: linkColors[i], border: `1px solid ${linkColors[i]}44` }}>{i + 1}</div>
                                        <input className="form-input" type="text" placeholder={captionMode === 'manual' ? `Caption for clip ${i + 1}` : 'Auto-generated'} value={cap} onChange={e => updateCaption(i, e.target.value)} onBlur={() => handleBlur(`cap-${i}`, cap)} id={`cap-${i}`} disabled={captionMode !== 'manual'} />
                                        <SavedIndicator show={savedFields[`cap-${i}`]} />
                                    </div>
                                ))}
                            </div>

                            <div className="actions-row" style={{ marginTop: 24 }}>
                                <button className="btn-secondary" onClick={handleClose}>Cancel</button>
                                <button className="btn-primary" onClick={startProcessing} disabled={!valid1} id="process-btn">
                                    Start Processing <FaArrowRight />
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Step 1: Processing ── */}
                    {step === 1 && (
                        <motion.div key="s1" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <LoadingAnimation progress={jobStatus.progress} message={jobStatus.message || 'Starting pipeline...'} isError={jobStatus.status === 'error'} />
                            {jobStatus.status === 'error' && (
                                <div style={{ marginTop: 16, textAlign: 'center' }}>
                                    <div style={{ background: 'rgba(234,67,53,0.08)', border: '1px solid rgba(234,67,53,0.3)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#EA4335', textAlign: 'left', lineHeight: 1.6, maxHeight: 120, overflow: 'auto' }}>
                                        {jobStatus.message}
                                    </div>
                                    <button className="btn-secondary" onClick={() => { setStep(0); setDirection(-1); setJobId(null); }}><FaArrowLeft /> Go Back & Retry</button>
                                </div>
                            )}
                        </motion.div>
                    )}

                    {/* ── Step 2: Preview ── */}
                    {step === 2 && (
                        <motion.div key="s2" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14 }}>
                                🎬 Your video is ready! Watch it below, download it if you like, then click <strong>Next</strong> to set up the YouTube upload.
                            </p>
                            
                            {/* Uses custom videofile:// protocol to play local file */}
                            <video key={jobId} src={videoFilePath ? `videofile:///${videoFilePath}` : ''} controls style={{ width: '100%', borderRadius: 12, background: '#000', marginBottom: 14, maxHeight: 380 }} />
                            
                            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 24, flexWrap: 'wrap' }}>
                                <button className="btn-secondary" onClick={handleDownload} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                    ⬇️ Save Video
                                </button>
                                <button className="btn-secondary" onClick={handleShare} disabled={shareStatus === 'uploading'} type="button">🔗 Share via Filebin</button>
                            </div>
                            
                            {shareStatus === 'uploading' && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: 13, marginBottom: 12 }}>Uploading to Filebin...</p>}
                            {shareStatus === 'error' && <p style={{ color: '#EA4335', textAlign: 'center', fontSize: 13, marginBottom: 12 }}>{shareError || 'Filebin upload failed'}</p>}
                            {shareStatus === 'success' && shareUrl && (
                                <div className="share-link">
                                    <span className="share-label">Filebin URL</span>
                                    <a href={shareUrl} target="_blank" rel="noreferrer" onClick={e => {
                                        e.preventDefault()
                                        window.electronAPI.openExternal(shareUrl)
                                    }}>{shareUrl}</a>
                                </div>
                            )}
                            
                            <div className="actions-row">
                                <button className="btn-secondary" onClick={() => go(-1)}><FaArrowLeft /> Back</button>
                                <button className="btn-primary" onClick={() => go(1)}>Next: YT Details <FaArrowRight /></button>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Step 3: YouTube Metadata ── */}
                    {step === 3 && (
                        <motion.div key="s3" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 14 }}>✅ Video processed! Now fill in the YouTube upload details.</p>
                            <div className="metadata-form">
                                <div className="form-group full-width">
                                    <label className="form-label">Video Title <SavedIndicator show={savedFields['yt-title']} /></label>
                                    <input className="form-input" type="text" placeholder="My Ranking Video #Shorts" value={meta.title} onChange={e => updateMeta('title', e.target.value)} onBlur={() => handleBlur('yt-title', meta.title)} maxLength={100} id="yt-title" />
                                    <span className="form-hint">Max 100 chars. Add #Shorts for short-form content.</span>
                                </div>
                                <div className="form-group full-width">
                                    <label className="form-label">Description <SavedIndicator show={savedFields['yt-desc']} /></label>
                                    <textarea className="form-input" placeholder="Describe your video... use keywords for SEO" value={meta.description} onChange={e => updateMeta('description', e.target.value)} onBlur={() => handleBlur('yt-desc', meta.description)} maxLength={5000} rows={3} id="yt-desc" />
                                    <span className="form-hint">Max 5,000 characters.</span>
                                </div>
                                <div className="form-group full-width">
                                    <label className="form-label">Tags <SavedIndicator show={savedFields['yt-tags']} /></label>
                                    <input className="form-input" type="text" placeholder="viral, cats, ranking, shorts" value={meta.tags} onChange={e => updateMeta('tags', e.target.value)} onBlur={() => handleBlur('yt-tags', meta.tags)} id="yt-tags" />
                                    <span className="form-hint">Comma-separated. e.g., "comedy, viral, tutorial"</span>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Privacy</label>
                                    <select className="form-select" value={meta.privacyStatus} onChange={e => updateMeta('privacyStatus', e.target.value)} id="yt-privacy">
                                        <option value="public">Public</option><option value="private">Private</option><option value="unlisted">Unlisted</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Category</label>
                                    <select className="form-select" value={meta.categoryId} onChange={e => updateMeta('categoryId', e.target.value)} id="yt-category">
                                        <option value="15">Pets &amp; Animals</option><option value="23">Comedy</option><option value="24">Entertainment</option><option value="22">People &amp; Blogs</option><option value="20">Gaming</option><option value="17">Sports</option><option value="10">Music</option><option value="27">Education</option><option value="28">Science &amp; Technology</option><option value="1">Film &amp; Animation</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Made for Kids</label>
                                    <select className="form-select" value={String(meta.madeForKids)} onChange={e => updateMeta('madeForKids', e.target.value === 'true')} id="yt-kids">
                                        <option value="false">No</option><option value="true">Yes</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Language</label>
                                    <select className="form-select" value={meta.language} onChange={e => updateMeta('language', e.target.value)} id="yt-lang">
                                        <option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="pt">Portuguese</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Audio Language</label>
                                    <select className="form-select" value={meta.defaultAudioLanguage} onChange={e => updateMeta('defaultAudioLanguage', e.target.value)} id="yt-audiolang">
                                        <option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="pt">Portuguese</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Recording Date</label>
                                    <input className="form-input" type="date" value={meta.recordingDate} onChange={e => updateMeta('recordingDate', e.target.value)} id="yt-date" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">License</label>
                                    <select className="form-select" value={meta.license} onChange={e => updateMeta('license', e.target.value)} id="yt-license">
                                        <option value="youtube">Standard YouTube</option><option value="creativeCommon">Creative Commons</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Embeddable</label>
                                    <select className="form-select" value={String(meta.embeddable)} onChange={e => updateMeta('embeddable', e.target.value === 'true')} id="yt-embed">
                                        <option value="true">Yes</option><option value="false">No</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Public Stats</label>
                                    <select className="form-select" value={String(meta.publicStatsViewable)} onChange={e => updateMeta('publicStatsViewable', e.target.value === 'true')} id="yt-stats">
                                        <option value="true">Visible</option><option value="false">Hidden</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Notify Subscribers</label>
                                    <select className="form-select" value={String(meta.notifySubscribers)} onChange={e => updateMeta('notifySubscribers', e.target.value === 'true')} id="yt-notify">
                                        <option value="true">Yes</option><option value="false">No</option>
                                    </select>
                                </div>
                            </div>
                            <div className="actions-row" style={{ marginTop: 24 }}>
                                <button className="btn-secondary" onClick={() => go(-1)}><FaArrowLeft /> Back</button>
                                <button className="btn-primary" onClick={() => go(1)} id="to-upload-btn">Continue to Upload <FaArrowRight /></button>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Step 4: Upload ── */}
                    {step === 4 && (
                        <motion.div key="s4" custom={direction} variants={stepVariants} initial="enter" animate="center" exit="exit">
                            {uploadStatus === 'success' ? (
                                <div className="success-container">
                                    <motion.div className="success-icon" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>🎉</motion.div>
                                    <h3 className="success-title">Upload Successful!</h3>
                                    <p className="success-subtitle">Your video is now on YouTube.</p>
                                    {youtubeVideoId && (
                                        <a href={`https://www.youtube.com/watch?v=${youtubeVideoId}`}
                                           onClick={e => { e.preventDefault(); window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${youtubeVideoId}`) }}
                                           className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                                            <FaExternalLinkAlt /> Watch on YouTube
                                        </a>
                                    )}
                                    <br />
                                    <button className="btn-secondary" onClick={handleClose} style={{ marginTop: 8 }}>Done</button>
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
                                                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 24 }}>Click Upload to publish your video now.</p>
                                                <button className="btn-primary" onClick={handleUpload} id="upload-btn">
                                                    <FaUpload /> Upload to YouTube
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <div style={{ fontSize: 48, marginBottom: 12 }}>🔐</div>
                                                <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 15 }}>Please sign in from the top navigation bar to upload.</p>
                                            </>
                                        )}
                                    </div>

                                    {uploadStatus === 'error' && (
                                        <div style={{ background: 'rgba(234,67,53,0.08)', border: '1px solid rgba(234,67,53,0.3)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#EA4335', lineHeight: 1.6 }}>
                                            <FaExclamationCircle style={{ marginRight: 8 }} />
                                            {uploadError || 'Upload failed. Please try again.'}
                                        </div>
                                    )}

                                    <div className="actions-row">
                                        <button className="btn-secondary" onClick={() => go(-1)} disabled={!!uploadStatus}><FaArrowLeft /> Back</button>
                                        {uploadStatus === 'error' && (
                                            <button className="btn-secondary" onClick={() => { setUploadStatus(null); setUploadError('') }}>Retry</button>
                                        )}
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
